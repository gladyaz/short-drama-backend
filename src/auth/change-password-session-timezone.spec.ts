import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { bcryptTestBudgetMs } from '../common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  fixtureEmail,
} from '../common/testing/fixture-namespace.helpers';
import { AuthService } from './auth.service';
import { DeletionAuthorizationService } from './deletion/deletion-authorization.service';
import { DisabledGoogleIdentityVerifier } from './identity/google/google-disabled.verifier';
import { GOOGLE_IDENTITY_VERIFIER } from './identity/google/google-identity.types';
import { WhatsAppOtpService } from './identity/whatsapp/whatsapp-otp.service';
import { DisabledWhatsAppOtpProvider } from './identity/whatsapp/whatsapp-disabled.provider';
import { WHATSAPP_OTP_PROVIDER } from './identity/whatsapp/whatsapp-otp.types';

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

// Slack for ordinary round-trip latency (bcrypt, network, event-loop
// scheduling) between capturing `callStartedAt`/`callFinishedAt` around the
// `changePassword` call and the UPDATE actually running inside it — NOT
// slack for the defect this spec guards against. That defect is a ~7 hour
// (25,200,000ms) skew from the database session's `Asia/Jakarta` (UTC+7)
// `TimeZone` setting, several orders of magnitude larger than any plausible
// value here, so a generous few seconds of tolerance cannot mask it.
const CLOCK_TOLERANCE_MS = 5_000;

/**
 * Phase 12, work unit 12D-B0 regression coverage.
 *
 * `AuthService.changePassword`'s revoke-all-sessions statement writes
 * `Session.revokedAt` via `tx.$queryRaw` directly against a real Postgres
 * connection (see that method's doc comment for why raw SQL is required
 * here — the `RETURNING "id"` clause Prisma's `updateMany` has no
 * equivalent for). This project's Postgres server's session `TimeZone` is
 * `Asia/Jakarta` (UTC+7, confirmed via `SHOW TimeZone`), NOT UTC. Before
 * this work unit, the statement assigned a bound `Date` parameter (which
 * Prisma binds as `timestamptz`) directly to the naive `timestamp(3)`
 * `"revokedAt"` column with no `AT TIME ZONE 'UTC'` conversion, so Postgres
 * silently reinterpreted the instant using the session's `Asia/Jakarta`
 * offset and stored the wrong wall-clock digits — corrupting the persisted
 * value by ~7 hours. A mocked Prisma client cannot exhibit this bug at all
 * (the corruption happens inside real Postgres's own type-coercion rules,
 * not in application code), so this spec deliberately runs against a real
 * database connection, mirroring `account-deletion.service.spec.ts`'s
 * existing precedent for a test that must not risk `short_drama_dev`.
 *
 * Kept in its own file (rather than folded into `auth.service.spec.ts`,
 * which shares `DATABASE_URL` — the dev database — per that file's own
 * documented precedent) specifically so this regression check runs against
 * the isolated `DATABASE_URL_TEST` database instead, per this work unit's
 * explicit requirement.
 */
/**
 * Auth test-stability slice: replaces Jest's inherited 5000ms default. Every
 * test here drives REAL cost-factor-12 bcrypt hashing through the real
 * `AuthService`; the most expensive one performs 5 such operations, which is
 * already a large fraction of 5000ms on a busy machine. See
 * `../common/testing/bcrypt-test-budget.helpers.ts` — a harness hang-detector
 * budget, NOT a business-security timeout.
 */
jest.setTimeout(bcryptTestBudgetMs(5));

describe('AuthService.changePassword — Session.revokedAt timezone correctness (Phase 12, 12D-B0)', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let originalDatabaseUrl: string | undefined;

  // Auth test-stability slice — see `fixture-namespace.helpers.ts`.
  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`cptz-${label}`);

  beforeAll(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!process.env.DATABASE_URL_TEST) {
      throw new Error(
        'DATABASE_URL_TEST is not set in .env — this regression spec must ' +
          'run against the dedicated short_drama_test database, never ' +
          'DATABASE_URL (dev). Copy .env.example and set DATABASE_URL_TEST ' +
          'before running npm test.',
      );
    }

    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        AuthService,
        PrismaService,
        AccountLockoutService,
        AuthAuditService,
        // V1 PROVIDER ACCOUNT DELETION: `AuthService.deleteAccount` now
        // delegates its proof check to `DeletionAuthorizationService`, so
        // this module must be able to construct one. Both external provider
        // ports are bound to the INERT `Disabled*` implementations —
        // the same objects `AuthModule`'s factories produce for this
        // repository's shipped default configuration — because no test in
        // this file deletes an account. If one ever did, they would refuse
        // rather than silently succeed. The proof matrix itself is covered
        // in `deletion/deletion-authorization.service.spec.ts`.
        DeletionAuthorizationService,
        WhatsAppOtpService,
        {
          provide: GOOGLE_IDENTITY_VERIFIER,
          useValue: new DisabledGoogleIdentityVerifier(),
        },
        {
          provide: WHATSAPP_OTP_PROVIDER,
          useValue: new DisabledWhatsAppOtpProvider(),
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(TEST_AUTH_CONFIG) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.authAuditEvent.deleteMany({
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

  it('stores Session.revokedAt as the true UTC instant the revoke ran at, not skewed by the database session TimeZone', async () => {
    const email = uniqueEmail('write-correctness');
    const oldPassword = 'correct-horse-battery';
    const newPassword = 'brand-new-password-1';

    const registered = await service.register({
      email,
      password: oldPassword,
    });
    const preChangeSession = await prisma.session.findFirstOrThrow({
      where: { user: { email } },
    });

    const callStartedAt = Date.now();
    await service.changePassword(registered.user.id, {
      currentPassword: oldPassword,
      newPassword,
      refreshToken: registered.refreshToken,
    });
    const callFinishedAt = Date.now();

    // Read the persisted value back two independent ways: Prisma's typed
    // ORM (this codebase's `AccountLockoutService.recordFailure` doc
    // comment confirms it reads naive `timestamp(3)` columns consistently
    // as UTC wall-clock digits) and a raw SQL `SELECT` of the exact same
    // column with no conversion applied — both must agree, and both must
    // land inside the narrow real-time window the call actually ran in,
    // not ~7 hours (25,200,000ms) outside it in either direction.
    const viaOrm = await prisma.session.findUniqueOrThrow({
      where: { id: preChangeSession.id },
      select: { revokedAt: true },
    });
    const viaRawSelect = await prisma.$queryRaw<{ revokedAt: Date }[]>`
      SELECT "revokedAt" FROM "Session" WHERE "id" = ${preChangeSession.id}
    `;

    expect(viaOrm.revokedAt).not.toBeNull();
    const storedMs = viaOrm.revokedAt!.getTime();
    expect(viaRawSelect[0].revokedAt.getTime()).toBe(storedMs);

    expect(storedMs).toBeGreaterThanOrEqual(callStartedAt - CLOCK_TOLERANCE_MS);
    expect(storedMs).toBeLessThanOrEqual(callFinishedAt + CLOCK_TOLERANCE_MS);
  });
});
