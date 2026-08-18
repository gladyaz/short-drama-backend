import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthService } from './auth.service';
import { bcryptTestBudgetMs } from '../common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from '../common/testing/fixture-namespace.helpers';

/**
 * Auth lock-order hardening slice — the executable proof for the "CANONICAL
 * AUTH LOCK ORDER" invariant documented above `AuthService`.
 *
 * Split into its own file rather than appended to the already 2700-line
 * `auth.service.spec.ts` because it needs a different shape of test: raw-SQL
 * statement replays driven by explicit barriers, not service-level fixtures.
 *
 * THE BUG THIS FILE PINS. Before this slice the three account-mutating
 * transactions in `AuthService` disagreed about which resource they locked
 * first:
 *
 *     changePassword        Session -> User
 *     deleteAccount         Session -> User
 *     confirmPasswordReset  PasswordResetToken -> User -> Session
 *
 * For a single account, `Session -> User` against `User -> Session` is a
 * lock cycle, and Postgres resolves it by killing one side with `40P01
 * deadlock detected` — surfaced by Prisma as a
 * `PrismaClientUnknownRequestError` that nothing catches, i.e. an opaque
 * `500` instead of any of the clean race paths those methods define.
 *
 * NO SLEEPS ANYWHERE. Every interleaving below is forced with deferred
 * promises resolved by observable database progress (a statement returning),
 * never by elapsed wall-clock time.
 *
 * POSITIVE CONTROL FIRST. The first two tests replay the PRE-FIX statement
 * orders at the raw-SQL level and assert the deadlock still happens. Without
 * them, the "canonical order does not deadlock" tests below could pass for
 * the wrong reason (a harness that cannot force the interleaving at all
 * would report green forever). They exercise raw SQL only — no `AuthService`
 * method runs the pre-fix order any more, and none may be reintroduced.
 */

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Postgres reports a broken lock cycle as SQLSTATE `40P01`. Prisma has no
 * typed error class for it (it is not one of the `P2xxx` known errors), so it
 * arrives as a `PrismaClientUnknownRequestError` carrying the raw connector
 * message — which is precisely why an unhandled one becomes a `500`.
 */
function isPostgresDeadlock(error: unknown): boolean {
  return /40P01|deadlock detected/i.test(
    String((error as { message?: unknown })?.message ?? error),
  );
}

/** Barriers shared by the two halves of a forced interleaving. */
interface Gates {
  readonly firstHolder: Deferred;
  readonly secondHolder: Deferred;
}

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Statement-order replays.
//
// Each function below reproduces, verbatim, the statement sequence one
// `AuthService` transaction issues — `PRE_FIX_*` as it stood at the baseline
// commit, `CANONICAL_*` as it stands now. They are kept as literal SQL/ORM
// calls rather than by calling the service, so the PRE_FIX orders remain
// reproducible after the service itself stopped using them.
// ---------------------------------------------------------------------------

async function lockUserRow(tx: Tx, userId: string, forDelete = false) {
  return forDelete
    ? tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`
    : tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
}

async function revokeAllSessionsRaw(tx: Tx, userId: string, now: Date) {
  return tx.$queryRaw<{ id: string }[]>`
    UPDATE "Session"
    SET "revokedAt" = ${now} AT TIME ZONE 'UTC'
    WHERE "userId" = ${userId} AND "revokedAt" IS NULL
    RETURNING "id"
  `;
}

async function claimAllResetTokensRaw(tx: Tx, userId: string, now: Date) {
  return tx.$queryRaw<{ id: string }[]>`
    UPDATE "PasswordResetToken"
    SET "usedAt" = ${now} AT TIME ZONE 'UTC'
    WHERE "userId" = ${userId} AND "usedAt" IS NULL AND ("expiresAt" AT TIME ZONE 'UTC') > ${now}
    RETURNING "id"
  `;
}

/** BASELINE `changePassword`: `Session` -> `User`. */
async function preFixChangePassword(
  tx: Tx,
  userId: string,
  now: Date,
  gates: Gates,
): Promise<void> {
  await revokeAllSessionsRaw(tx, userId, now);
  gates.firstHolder.resolve(); // Session row locks are now HELD by this tx.
  await gates.secondHolder.promise; // ...and the other tx now holds `User`.
  await tx.user.update({
    where: { id: userId },
    data: { passwordHash: 'pre-fix-change-password' },
  });
}

/** BASELINE `deleteAccount`: `Session` -> `AuthAuditEvent` -> `User`. */
async function preFixDeleteAccount(
  tx: Tx,
  userId: string,
  now: Date,
  gates: Gates,
): Promise<void> {
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  gates.firstHolder.resolve();
  await gates.secondHolder.promise;
  await tx.authAuditEvent.updateMany({
    where: { userId },
    data: { userId: null },
  });
  await tx.user.deleteMany({ where: { id: userId } });
}

/** BASELINE `confirmPasswordReset`: `PasswordResetToken` -> `User` -> `Session`. */
async function preFixConfirmPasswordReset(
  tx: Tx,
  userId: string,
  now: Date,
  gates: Gates,
): Promise<void> {
  await gates.firstHolder.promise; // the other tx already holds every `Session` row
  await claimAllResetTokensRaw(tx, userId, now);
  await tx.user.update({
    where: { id: userId },
    data: { passwordHash: 'pre-fix-confirm-reset' },
  });
  gates.secondHolder.resolve(); // `User` row lock is now HELD by this tx.
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
}

/** CURRENT `changePassword`: `User` -> `Session`. */
async function canonicalChangePassword(
  tx: Tx,
  userId: string,
  now: Date,
  gates: Gates,
): Promise<void> {
  await lockUserRow(tx, userId);
  gates.firstHolder.resolve(); // `User` row lock HELD; the other tx is about to queue on it.
  await gates.secondHolder.promise;
  await revokeAllSessionsRaw(tx, userId, now);
  await tx.user.update({
    where: { id: userId },
    data: { passwordHash: 'canonical-change-password' },
  });
}

/** CURRENT `deleteAccount`: `User` -> `Session` -> `AuthAuditEvent` -> `User` (delete). */
async function canonicalDeleteAccount(
  tx: Tx,
  userId: string,
  now: Date,
  gates: Gates,
): Promise<void> {
  await lockUserRow(tx, userId, true);
  gates.firstHolder.resolve();
  await gates.secondHolder.promise;
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.authAuditEvent.updateMany({
    where: { userId },
    data: { userId: null },
  });
  await tx.user.deleteMany({ where: { id: userId } });
}

/** CURRENT `confirmPasswordReset`: `User` -> `PasswordResetToken` -> `Session`. */
async function canonicalConfirmPasswordReset(
  tx: Tx,
  userId: string,
  now: Date,
  gates: Gates,
): Promise<void> {
  await gates.firstHolder.promise;
  // Signalled BEFORE the blocking statement, so the other transaction is
  // never waiting on a gate this one can only resolve after it unblocks —
  // that would be a deadlock in the harness rather than in Postgres.
  gates.secondHolder.resolve();
  const locked = await lockUserRow(tx, userId); // queues behind the other tx
  if ((locked as unknown[]).length === 0) {
    return; // account deleted by the transaction we queued behind
  }
  await claimAllResetTokensRaw(tx, userId, now);
  await tx.user.update({
    where: { id: userId },
    data: { passwordHash: 'canonical-confirm-reset' },
  });
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
}

/**
 * Prisma model delegates reachable from a `Prisma.TransactionClient` in this
 * auth surface. Used by `recordingTx` below to know which property accesses
 * are model delegates (and so should have their operations recorded) rather
 * than ordinary client internals.
 */
const RECORDED_MODEL_DELEGATES = new Set([
  'user',
  'session',
  'passwordResetToken',
  'authAuditEvent',
  'accountLockout',
]);

/**
 * The canonical `User`-row lock, as `recordingTx` renders it. Matching the
 * literal statement (not merely "some statement touching User") is
 * deliberate: a plain `SELECT`, or an `UPDATE "User"` that happens to be
 * first, would NOT establish the ordering guarantee — only an explicit row
 * lock does.
 */
const USER_ROW_LOCK_STATEMENT =
  /^\$queryRaw: SELECT "id" FROM "User" WHERE "id" = \? FOR (NO KEY UPDATE|UPDATE)$/;

/**
 * Wraps a `Prisma.TransactionClient` so every statement a service issues
 * through it is appended to `log`, in order, before being forwarded
 * unchanged.
 *
 * This is what turns "the canonical order is documented" into "the canonical
 * order is ENFORCED": the tests using it assert, structurally and without
 * any timing dependency, that each account-mutating transaction's FIRST
 * database statement is the `User` row lock. A revert to the pre-fix order
 * fails them immediately and unambiguously, rather than only showing up as
 * an occasional `40P01` under load.
 */
type UnknownRecord = Record<string, unknown>;
type UnknownFn = (...args: unknown[]) => unknown;

function recordingTx(tx: Tx, log: string[]): Tx {
  const delegateHandler = (modelName: string): ProxyHandler<UnknownRecord> => ({
    get(delegate, operation): unknown {
      if (typeof operation !== 'string') {
        return Reflect.get(delegate, operation);
      }
      const method = delegate[operation];
      if (typeof method !== 'function') {
        return method;
      }
      return (...args: unknown[]): unknown => {
        log.push(`${modelName}.${operation}`);
        return (method as UnknownFn).apply(delegate, args);
      };
    },
  });

  const handler: ProxyHandler<UnknownRecord> = {
    get(target, property): unknown {
      if (typeof property !== 'string') {
        return Reflect.get(target, property);
      }

      const value = target[property];

      if (property === '$queryRaw' || property === '$executeRaw') {
        return (...args: unknown[]): unknown => {
          const [strings] = args;
          const sql = Array.isArray(strings)
            ? strings.join('?')
            : String(strings);
          log.push(`${property}: ${sql.replace(/\s+/g, ' ').trim()}`);
          return (value as UnknownFn).apply(target, args);
        };
      }

      if (
        RECORDED_MODEL_DELEGATES.has(property) &&
        typeof value === 'object' &&
        value !== null
      ) {
        const delegate: UnknownRecord = value as UnknownRecord;
        return new Proxy(delegate, delegateHandler(property));
      }

      return typeof value === 'function'
        ? (value as UnknownFn).bind(target)
        : value;
    },
  };

  const target = tx as unknown as UnknownRecord;
  return new Proxy(target, handler) as unknown as Tx;
}

/**
 * `prisma.$transaction` seen through a signature loose enough to spy on
 * without fighting its typed overloads. The spies below always forward to the
 * real implementation; nothing about the transaction is faked.
 */
interface LooseTransactionClient {
  $transaction: UnknownFn;
}

jest.setTimeout(bcryptTestBudgetMs(8));

describe('AuthService — canonical auth lock order', () => {
  let service: AuthService;
  let prisma: PrismaService;

  const emailPrefix = TEST_FIXTURE_NAMESPACE;

  /**
   * Both real-service race tests below run several iterations: they depend on
   * which transaction wins a genuine `User`-row lock race, so a single
   * iteration would only ever exercise one of the two orderings. Kept small
   * because every iteration performs real cost-factor-12 bcrypt work.
   */
  const RACE_TEST_ITERATIONS = 6;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        AuthService,
        PrismaService,
        AccountLockoutService,
        AuthAuditService,
        {
          provide: ConfigService,
          useValue: {
            // `devToolsEnabled` is what makes `requestPasswordReset` return
            // the raw token these tests need; every other key resolves to the
            // same stub auth config the other auth specs use.
            get: jest.fn((key: string) =>
              key === 'app' ? { devToolsEnabled: true } : TEST_AUTH_CONFIG,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    // Per-run namespace cleanup, matching `auth.service.spec.ts` exactly —
    // never a hardcoded `contains(...)` marker (see
    // `fixture-namespace.helpers.ts` for why that mattered).
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.accountLockout.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.passwordResetToken.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    await prisma.onModuleDestroy();
  });

  /**
   * Seeds a bare account with one active session and one outstanding reset
   * token, WITHOUT bcrypt: the raw-SQL lock tests care only about which rows
   * exist to be locked, never about password verification, so paying for real
   * cost-12 hashing here would slow them down for nothing.
   */
  async function seedLockFixture(label: string): Promise<string> {
    const email = fixtureEmail(label);
    const user = await prisma.user.create({
      data: { email, passwordHash: `${emailPrefix}-seed-hash` },
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: `${emailPrefix}-${label}-session`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: `${emailPrefix}-${label}-reset-token`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.authAuditEvent.create({
      data: { userId: user.id, event: 'login_success' },
    });
    return user.id;
  }

  /**
   * Runs two transactions concurrently against the same account, forced into
   * the given interleaving, and reports every error either one raised.
   */
  async function raceTransactions(
    userId: string,
    first: (tx: Tx, userId: string, now: Date, gates: Gates) => Promise<void>,
    second: (tx: Tx, userId: string, now: Date, gates: Gates) => Promise<void>,
  ): Promise<{ errors: unknown[]; committed: number }> {
    const gates: Gates = {
      firstHolder: deferred(),
      secondHolder: deferred(),
    };
    const now = new Date();
    const errors: unknown[] = [];
    let committed = 0;

    const run = (
      body: (tx: Tx, userId: string, now: Date, gates: Gates) => Promise<void>,
    ) =>
      prisma
        .$transaction((tx) => body(tx, userId, now, gates))
        .then(() => {
          committed += 1;
        })
        .catch((error: unknown) => {
          errors.push(error);
          // Release both gates so the sibling transaction can never hang
          // waiting on a barrier this (now dead) one will no longer resolve.
          gates.firstHolder.resolve();
          gates.secondHolder.resolve();
        });

    await Promise.all([run(first), run(second)]);
    return { errors, committed };
  }

  describe('positive control: the pre-fix statement orders really do deadlock', () => {
    it('changePassword (Session -> User) racing confirmPasswordReset (User -> Session) is killed by Postgres 40P01', async () => {
      const userId = await seedLockFixture('pre-fix-cp-cpr');

      const { errors } = await raceTransactions(
        userId,
        preFixChangePassword,
        preFixConfirmPasswordReset,
      );

      // Exactly the failure this slice exists to remove: an unhandled
      // SQLSTATE 40P01, which reaches the client as an opaque 500.
      expect(errors.some(isPostgresDeadlock)).toBe(true);
    });

    it('deleteAccount (Session -> User) racing confirmPasswordReset (User -> Session) is killed by Postgres 40P01', async () => {
      const userId = await seedLockFixture('pre-fix-del-cpr');

      const { errors } = await raceTransactions(
        userId,
        preFixDeleteAccount,
        preFixConfirmPasswordReset,
      );

      expect(errors.some(isPostgresDeadlock)).toBe(true);
    });
  });

  describe('the canonical order (User first) cannot form a cycle', () => {
    it('changePassword racing confirmPasswordReset: both transactions commit, no deadlock', async () => {
      const userId = await seedLockFixture('canon-cp-cpr');

      const { errors, committed } = await raceTransactions(
        userId,
        canonicalChangePassword,
        canonicalConfirmPasswordReset,
      );

      expect(errors).toEqual([]);
      expect(committed).toBe(2);

      // The second transaction serialized behind the first rather than
      // deadlocking with it, so the account's end state is the later
      // writer's, whole — never a half-applied mixture.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.passwordHash).toBe('canonical-confirm-reset');
      const active = await prisma.session.count({
        where: { userId, revokedAt: null },
      });
      expect(active).toBe(0);
    });

    it('deleteAccount racing confirmPasswordReset: both transactions commit, no deadlock', async () => {
      const userId = await seedLockFixture('canon-del-cpr');

      const { errors, committed } = await raceTransactions(
        userId,
        canonicalDeleteAccount,
        canonicalConfirmPasswordReset,
      );

      expect(errors).toEqual([]);
      expect(committed).toBe(2);

      const survivor = await prisma.user.findUnique({ where: { id: userId } });
      expect(survivor).toBeNull();
    });
  });

  describe('the User row lock is the FIRST statement of every account-mutating transaction', () => {
    const OLD_PASSWORD = 'correct-horse-battery';

    /**
     * Records the statement sequence of every interactive transaction the
     * service opens during `run`, by handing the service a recording proxy
     * over the real `tx` client. Nothing is stubbed — every statement still
     * executes against the real database.
     */
    async function captureTransactionStatements(
      run: () => Promise<unknown>,
    ): Promise<string[][]> {
      const transactions: string[][] = [];
      const loose = prisma as unknown as LooseTransactionClient;
      const original = loose.$transaction;
      const realTransaction: UnknownFn = (...args: unknown[]) =>
        original.apply(prisma, args);

      const spy = jest
        .spyOn(loose, '$transaction')
        .mockImplementation((...args: unknown[]): unknown => {
          const [first, options] = args;
          if (typeof first !== 'function') {
            // Batch (array) form — not used by these methods, forwarded as-is.
            return realTransaction(...args);
          }
          const log: string[] = [];
          transactions.push(log);
          return realTransaction(
            (tx: Tx) => (first as (t: Tx) => unknown)(recordingTx(tx, log)),
            options,
          );
        });

      try {
        await run();
      } finally {
        spy.mockRestore();
      }

      return transactions;
    }

    it("changePassword's transaction locks the User row before touching Session", async () => {
      const email = fixtureEmail('order-change-password');
      const registered = await service.register({
        email,
        password: OLD_PASSWORD,
      });

      const [statements] = await captureTransactionStatements(() =>
        service.changePassword(registered.user.id, {
          currentPassword: OLD_PASSWORD,
          newPassword: 'brand-new-password-order-1',
          refreshToken: registered.refreshToken,
        }),
      );

      expect(statements[0]).toMatch(USER_ROW_LOCK_STATEMENT);
      // ...and every later statement stays inside the canonical rank
      // (`User` -> `PasswordResetToken` -> `Session` -> `AuthAuditEvent`).
      expect(statements.slice(1)).toEqual([
        expect.stringContaining('UPDATE "Session"'),
        'user.update',
        'session.create',
        'session.updateMany',
      ]);
    });

    it("confirmPasswordReset's transaction locks the User row before claiming the token", async () => {
      const email = fixtureEmail('order-confirm-reset');
      await service.register({ email, password: OLD_PASSWORD });
      const { devToken } = await service.requestPasswordReset({ email });

      const [statements] = await captureTransactionStatements(() =>
        service.confirmPasswordReset({
          token: devToken!,
          newPassword: 'brand-new-password-order-2',
        }),
      );

      expect(statements[0]).toMatch(USER_ROW_LOCK_STATEMENT);
      expect(statements.slice(1)).toEqual([
        expect.stringContaining('UPDATE "PasswordResetToken"'),
        'user.update',
        'session.updateMany',
      ]);
    });

    it("deleteAccount's transaction locks the User row before revoking sessions", async () => {
      const email = fixtureEmail('order-delete-account');
      const registered = await service.register({
        email,
        password: OLD_PASSWORD,
      });

      const [statements] = await captureTransactionStatements(() =>
        service.deleteAccount(registered.user.id, {
          currentPassword: OLD_PASSWORD,
          confirmDeletion: true,
        }),
      );

      expect(statements[0]).toMatch(USER_ROW_LOCK_STATEMENT);
      expect(statements.slice(1)).toEqual([
        'session.updateMany',
        'authAuditEvent.updateMany',
        'user.deleteMany',
      ]);
    });

    it('no JWT signing happens inside a transaction holding the User row lock', async () => {
      const email = fixtureEmail('order-no-crypto-in-tx');
      const registered = await service.register({
        email,
        password: OLD_PASSWORD,
      });

      // `session.create` inside the transaction receives an ALREADY-signed
      // access token and an already-hashed refresh token (see
      // `prepareTokenPair`). If the JWT were signed inside the transaction,
      // the account's `User` row lock — and a pooled connection — would be
      // held across an `await`ed, event-loop-yielding crypto call, precisely
      // while `bcryptjs` is saturating that same single-threaded loop.
      //
      // The two bcrypt calls are covered by the statement-order test above
      // rather than by a spy: `bcryptjs` exports non-configurable bindings,
      // so `jest.spyOn(bcrypt, 'hash')` throws `Cannot redefine property`.
      // That test pins the transaction's contents to exactly five database
      // statements, which is what rules out any other work inside it.
      const signSpy = jest.spyOn(
        service['jwtService'] as { signAsync: (...a: unknown[]) => unknown },
        'signAsync',
      );

      let signCallsAtTransactionStart = -1;

      const loose = prisma as unknown as LooseTransactionClient;
      const original = loose.$transaction;
      const realTransaction: UnknownFn = (...args: unknown[]) =>
        original.apply(prisma, args);
      const txSpy = jest
        .spyOn(loose, '$transaction')
        .mockImplementation((...args: unknown[]): unknown => {
          const [first, options] = args;
          if (typeof first !== 'function') {
            return realTransaction(...args);
          }
          signCallsAtTransactionStart = signSpy.mock.calls.length;
          return realTransaction(first, options);
        });

      let signCallsAfterCompletion = -1;
      try {
        await service.changePassword(registered.user.id, {
          currentPassword: OLD_PASSWORD,
          newPassword: 'brand-new-password-order-3',
          refreshToken: registered.refreshToken,
        });
        // Read BEFORE `mockRestore()`, which discards the recorded calls.
        signCallsAfterCompletion = signSpy.mock.calls.length;
      } finally {
        txSpy.mockRestore();
        signSpy.mockRestore();
      }

      // The counter was already at its final value when the transaction
      // opened — the access token was signed before it, not inside it.
      expect(signCallsAtTransactionStart).toBeGreaterThan(0);
      expect(signCallsAfterCompletion).toBe(signCallsAtTransactionStart);
    });
  });

  describe('real AuthService methods under the canonical order', () => {
    const OLD_PASSWORD = 'correct-horse-battery';
    const CHANGED_PASSWORD = 'changed-password-alpha-1';
    const RESET_PASSWORD = 'reset-password-bravo-2';

    interface SeededAccount {
      userId: string;
      email: string;
      refreshToken: string;
      rawResetToken: string;
    }

    async function seedAccountWithResetToken(
      label: string,
    ): Promise<SeededAccount> {
      const email = fixtureEmail(label);
      const registered = await service.register({
        email,
        password: OLD_PASSWORD,
      });
      const { devToken } = await service.requestPasswordReset({ email });
      return {
        userId: registered.user.id,
        email,
        refreshToken: registered.refreshToken,
        rawResetToken: devToken!,
      };
    }

    /** Every caller-facing rejection must be a modelled `AppException`. */
    function expectNoUnhandledFailure(
      results: PromiseSettledResult<unknown>[],
    ) {
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(isPostgresDeadlock(result.reason)).toBe(false);
          expect(result.reason).toBeInstanceOf(AppException);
        }
      }
    }

    it(
      'concurrent changePassword + confirmPasswordReset never deadlocks and leaves exactly one truthful password with no surviving session',
      async () => {
        for (let i = 0; i < RACE_TEST_ITERATIONS; i += 1) {
          const account = await seedAccountWithResetToken(`race-cp-cpr-${i}`);

          const results = await Promise.allSettled([
            service.changePassword(account.userId, {
              currentPassword: OLD_PASSWORD,
              newPassword: CHANGED_PASSWORD,
              refreshToken: account.refreshToken,
            }),
            service.confirmPasswordReset({
              token: account.rawResetToken,
              newPassword: RESET_PASSWORD,
            }),
          ]);

          expectNoUnhandledFailure(results);

          const user = await prisma.user.findUniqueOrThrow({
            where: { id: account.userId },
          });

          // No torn write: the stored hash verifies against exactly ONE of
          // the two candidate passwords, and never against the original.
          const matchesChanged = await bcrypt.compare(
            CHANGED_PASSWORD,
            user.passwordHash,
          );
          const matchesReset = await bcrypt.compare(
            RESET_PASSWORD,
            user.passwordHash,
          );
          const matchesOld = await bcrypt.compare(
            OLD_PASSWORD,
            user.passwordHash,
          );
          expect(matchesOld).toBe(false);
          expect([matchesChanged, matchesReset].filter(Boolean)).toHaveLength(
            1,
          );

          // `confirmPasswordReset` is the strictly later writer in BOTH
          // orderings, which the `User`-row lock now makes deterministic:
          // if it wins the lock it commits first and `changePassword` then
          // finds its own session already revoked and rolls back; if it
          // loses the lock it runs afterwards against a token that is still
          // unused and unexpired, and claims it. Either way its password is
          // the one that survives — and, either way, it revokes every
          // session, including any replacement `changePassword` created.
          expect(matchesReset).toBe(true);

          const activeSessions = await prisma.session.count({
            where: { userId: account.userId, revokedAt: null },
          });
          expect(activeSessions).toBe(0);

          // The pre-change session's refresh token is dead no matter which
          // ordering won.
          await expect(service.refresh(account.refreshToken)).rejects.toThrow(
            AppException,
          );
        }
      },
      // Per iteration: register 1 + changePassword 2 + confirmPasswordReset 1
      // + 3 verification compares = 7 real cost-12 operations.
      bcryptTestBudgetMs(RACE_TEST_ITERATIONS * 7),
    );

    it(
      'a change-password attempt that started before a reset committed cannot overwrite that reset',
      async () => {
        const account = await seedAccountWithResetToken('stale-cp-vs-reset');

        // Sequential, so the ordering is fixed rather than raced: the reset
        // completes in full first, revoking every session.
        await service.confirmPasswordReset({
          token: account.rawResetToken,
          newPassword: RESET_PASSWORD,
        });

        // The change-password caller still holds the pre-reset refresh token
        // and still believes `OLD_PASSWORD` is current — exactly the state a
        // request that started before the reset committed would be in.
        await expect(
          service.changePassword(account.userId, {
            currentPassword: OLD_PASSWORD,
            newPassword: CHANGED_PASSWORD,
            refreshToken: account.refreshToken,
          }),
        ).rejects.toMatchObject({ code: AppErrorCode.INVALID_REFRESH_TOKEN });

        const user = await prisma.user.findUniqueOrThrow({
          where: { id: account.userId },
        });
        expect(await bcrypt.compare(RESET_PASSWORD, user.passwordHash)).toBe(
          true,
        );
        expect(await bcrypt.compare(CHANGED_PASSWORD, user.passwordHash)).toBe(
          false,
        );
      },
      bcryptTestBudgetMs(6),
    );

    it(
      'a reset token predating a completed changePassword still confirms (pre-existing semantic) and still leaves one truthful password and zero sessions',
      async () => {
        const account = await seedAccountWithResetToken('reset-after-change');

        const rotated = await service.changePassword(account.userId, {
          currentPassword: OLD_PASSWORD,
          newPassword: CHANGED_PASSWORD,
          refreshToken: account.refreshToken,
        });

        // DELIBERATELY PINNED, NOT ENDORSED: `changePassword` does not
        // consume outstanding `PasswordResetToken` rows, so a token issued
        // before it still works afterwards. That is pre-existing product
        // behavior (a reset token is bound to control of the account's
        // mailbox, which already outranks knowledge of the password), and
        // this slice is scoped to lock ordering, not to password-reset
        // policy — see the slice report's "remaining limitations". The test
        // exists so that changing it later is a deliberate act with a
        // failing test to update, not an accident.
        await service.confirmPasswordReset({
          token: account.rawResetToken,
          newPassword: RESET_PASSWORD,
        });

        const user = await prisma.user.findUniqueOrThrow({
          where: { id: account.userId },
        });
        expect(await bcrypt.compare(RESET_PASSWORD, user.passwordHash)).toBe(
          true,
        );
        expect(await bcrypt.compare(CHANGED_PASSWORD, user.passwordHash)).toBe(
          false,
        );

        // The reset swept away the replacement session `changePassword`
        // issued — no session survives a password reset, which is the whole
        // point of the endpoint.
        const activeSessions = await prisma.session.count({
          where: { userId: account.userId, revokedAt: null },
        });
        expect(activeSessions).toBe(0);
        await expect(service.refresh(rotated.refreshToken)).rejects.toThrow(
          AppException,
        );
      },
      bcryptTestBudgetMs(8),
    );

    it(
      'a login() racing confirmPasswordReset() with the still-valid OLD password never leaves a surviving session',
      async () => {
        for (let i = 0; i < RACE_TEST_ITERATIONS; i += 1) {
          const account = await seedAccountWithResetToken(
            `race-login-cpr-${i}`,
          );

          const results = await Promise.allSettled([
            service.login({ email: account.email, password: OLD_PASSWORD }),
            service.confirmPasswordReset({
              token: account.rawResetToken,
              newPassword: RESET_PASSWORD,
            }),
          ]);

          expectNoUnhandledFailure(results);

          // The reset always wins the account: either it committed first and
          // `login`'s `FOR SHARE` re-read saw the new hash, or `login`
          // committed first and the reset's own revoke-all swept its session.
          const [loginResult] = results;
          expect(results[1].status).toBe('fulfilled');

          const activeSessions = await prisma.session.count({
            where: { userId: account.userId, revokedAt: null },
          });
          expect(activeSessions).toBe(0);

          if (loginResult.status === 'fulfilled') {
            await expect(
              service.refresh(loginResult.value.refreshToken),
            ).rejects.toThrow(AppException);
          } else {
            expect(loginResult.reason).toMatchObject({
              code: AppErrorCode.INVALID_CREDENTIALS,
            });
          }
        }
      },
      // Per iteration: register 1 + login 1 + confirmPasswordReset 1 = 3.
      bcryptTestBudgetMs(RACE_TEST_ITERATIONS * 3),
    );

    it(
      'a refresh() racing confirmPasswordReset() never leaves a surviving replacement session',
      async () => {
        for (let i = 0; i < RACE_TEST_ITERATIONS; i += 1) {
          const account = await seedAccountWithResetToken(
            `race-refresh-cpr-${i}`,
          );

          const results = await Promise.allSettled([
            service.refresh(account.refreshToken),
            service.confirmPasswordReset({
              token: account.rawResetToken,
              newPassword: RESET_PASSWORD,
            }),
          ]);

          expectNoUnhandledFailure(results);
          expect(results[1].status).toBe('fulfilled');

          const activeSessions = await prisma.session.count({
            where: { userId: account.userId, revokedAt: null },
          });
          expect(activeSessions).toBe(0);

          const [refreshResult] = results;
          if (refreshResult.status === 'fulfilled') {
            await expect(
              service.refresh(refreshResult.value.refreshToken),
            ).rejects.toThrow(AppException);
          } else {
            expect(refreshResult.reason).toMatchObject({
              code: AppErrorCode.INVALID_REFRESH_TOKEN,
            });
          }
        }
      },
      // Per iteration: register 1 + confirmPasswordReset 1 (refresh hashes
      // nothing) = 2.
      bcryptTestBudgetMs(RACE_TEST_ITERATIONS * 2),
    );

    it(
      'concurrent deleteAccount + confirmPasswordReset never deadlocks and converges on the account being deleted',
      async () => {
        for (let i = 0; i < RACE_TEST_ITERATIONS; i += 1) {
          const account = await seedAccountWithResetToken(`race-del-cpr-${i}`);

          const results = await Promise.allSettled([
            service.deleteAccount(account.userId, {
              currentPassword: OLD_PASSWORD,
              confirmDeletion: true,
            }),
            service.confirmPasswordReset({
              token: account.rawResetToken,
              newPassword: RESET_PASSWORD,
            }),
          ]);

          expectNoUnhandledFailure(results);
          expect(results[0].status).toBe('fulfilled');

          const survivor = await prisma.user.findUnique({
            where: { id: account.userId },
          });
          expect(survivor).toBeNull();
        }
      },
      // Per iteration: register 1 + deleteAccount 1 + confirmPasswordReset 1.
      bcryptTestBudgetMs(RACE_TEST_ITERATIONS * 3),
    );

    it(
      'the audit trail stays truthful: no success event is written for the operation that did not apply',
      async () => {
        const account = await seedAccountWithResetToken('audit-truthful');

        const results = await Promise.allSettled([
          service.changePassword(account.userId, {
            currentPassword: OLD_PASSWORD,
            newPassword: CHANGED_PASSWORD,
            refreshToken: account.refreshToken,
          }),
          service.confirmPasswordReset({
            token: account.rawResetToken,
            newPassword: RESET_PASSWORD,
          }),
        ]);

        expectNoUnhandledFailure(results);

        const events = await prisma.authAuditEvent.findMany({
          where: { userId: account.userId },
          select: { event: true },
        });
        const countOf = (name: string) =>
          events.filter((e) => e.event === name).length;

        // The reset applied, so exactly one `password_reset_confirmed` row
        // exists — never zero (a silent success) and never two.
        expect(countOf('password_reset_confirmed')).toBe(1);

        // `change_password_success` may only exist if that call actually
        // resolved; a rejected call must leave no success row behind.
        const changeSucceeded = results[0].status === 'fulfilled';
        expect(countOf('change_password_success')).toBe(
          changeSucceeded ? 1 : 0,
        );

        // A rejected change-password is recorded as the same
        // `refresh_reuse_detected` / `concurrent_rotation_race` outcome every
        // other "revoked out from under a concurrent caller" case uses.
        if (!changeSucceeded) {
          expect(countOf('refresh_reuse_detected')).toBeGreaterThanOrEqual(1);
        }
      },
      bcryptTestBudgetMs(6),
    );
  });
});
