import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes } from 'crypto';
import { Prisma, type User } from '@prisma/client';
import { RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { hashIp, sanitizeUserAgent } from './auth-crypto';
import {
  ACCESS_TOKEN_TTL,
  BCRYPT_COST_FACTOR,
  DUMMY_HASH_FOR_TIMING_PARITY,
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TOKEN_HASH_DOMAIN,
  PASSWORD_RESET_TOKEN_TTL_MS,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';
import {
  AuthRequestContext,
  AuthResponseDto,
  AuthUserDto,
  PasswordResetRequestResponseDto,
  SessionSummaryDto,
} from './auth.types';
import { AccountDeletionDto } from './dto/account-deletion.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { PasswordResetConfirmDto } from './dto/password-reset-confirm.dto';
import { PasswordResetRequestDto } from './dto/password-reset-request.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * Any object exposing the same `session`/`user` Prisma model delegates as
 * `PrismaService` — either the real `PrismaService` singleton, or the
 * `tx` handle Prisma hands an interactive `$transaction(async (tx) => ...)`
 * callback. `issueTokensAndSession` accepts either so it can be reused
 * UNCHANGED both outside a transaction (register/login/refresh, as before)
 * and inside one (Phase 12, work unit 12B-B1's `changePassword`, which must
 * create the replacement session in the SAME transaction as the password
 * update and the other-session revocation).
 */
type PrismaClientLike = PrismaService | Prisma.TransactionClient;

/**
 * Everything `issueTokensAndSession` computes BEFORE touching the database —
 * the signed access token, the opaque refresh token and its keyed hash, and
 * the sanitized/hashed request-context columns. Split out so `login` can do
 * all of it outside the transaction that guards its session creation; see
 * `AuthService.prepareTokenPair`.
 */
interface PreparedSessionTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  ipHash: string | undefined;
  userAgent: string | undefined;
}

/**
 * Generic, user-enumeration-safe error used for both login and refresh
 * failures (see `AppErrorCode` for the security rationale).
 */
function invalidCredentials(): AppException {
  return new AppException(
    AppErrorCode.INVALID_CREDENTIALS,
    'Invalid email or password',
    HttpStatus.UNAUTHORIZED,
  );
}

function invalidRefreshToken(): AppException {
  return new AppException(
    AppErrorCode.INVALID_REFRESH_TOKEN,
    'Invalid or expired refresh token',
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * Phase 12, work unit 12B-B3: generic, anti-enumeration-safe error for
 * `POST /auth/password-reset/confirm` — used identically for a token that
 * does not exist at all, one that was already used, one that has expired,
 * and one that lost the single-use claim race (see
 * `AuthService.confirmPasswordReset`'s doc comment). Mirrors
 * `invalidCredentials`/`invalidRefreshToken` above exactly: never split this
 * into more specific codes, which would let a caller distinguish "this
 * token never existed" from "someone already used it" from "you waited too
 * long".
 */
function invalidPasswordResetToken(): AppException {
  return new AppException(
    AppErrorCode.INVALID_PASSWORD_RESET_TOKEN,
    'Invalid or expired password reset token',
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * Fix cycle 1 (test-reviewer finding, follow-up to work unit 12C-B1):
 * `Session_userId_fkey` (`prisma/migrations/20260723055428_init_postgresql/
 * migration.sql`) is the Postgres foreign key that makes a `Session` row
 * referencing a nonexistent `User` structurally impossible at the database
 * level. Before `deleteAccount` (12C-B1) shipped, nothing in this file could
 * ever violate it — every `client.session.create()` call sees a `userId`
 * this same request just read (`register`/`login`), or already verified
 * still resolves to a real user (`refresh`, `changePassword`), moments
 * earlier. `deleteAccount` introduced the first code path that can
 * hard-delete the `User` row out from under that assumption: a `login()` or
 * `refresh()` racing a CONCURRENT `deleteAccount()` for the SAME account can
 * have the `User` row vanish in the narrow window between this request's own
 * existence check and `issueTokensAndSession`'s `session.create()` —
 * Postgres then rejects the insert with `P2003`, which nothing previously
 * caught, so it fell through to `AppExceptionFilter`'s generic catch-all as
 * an undocumented, raw `500` instead of the clean, already-established
 * "user vanished mid-flight" error each caller uses elsewhere in this file.
 *
 * Matches ONLY the exact constraint `issueTokensAndSession`'s own
 * `session.create()` can violate (`error.meta.constraint`, verified
 * empirically against this project's Prisma 6.19.3 + Postgres combination),
 * not a bare `error.code === 'P2003'` check — `Session` has exactly one
 * foreign key today, so this is currently redundant, but it costs nothing
 * and means a future second FK on `Session` (or any other `P2003` this
 * function might one day encounter) is never silently reinterpreted as "the
 * user vanished" by this narrow catch.
 */
const SESSION_USER_FOREIGN_KEY_VIOLATION = 'P2003';
const SESSION_USER_FOREIGN_KEY_CONSTRAINT = 'Session_userId_fkey';

function isSessionUserForeignKeyViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === SESSION_USER_FOREIGN_KEY_VIOLATION &&
    error.meta?.constraint === SESSION_USER_FOREIGN_KEY_CONSTRAINT
  );
}

/**
 * Internal-only rollback signal for `AuthService.login`'s session-creation
 * transaction (Auth test-stability slice). Thrown INSIDE the transaction so
 * Prisma rolls it back when the account's `passwordHash` no longer matches
 * the one this request authenticated against — i.e. a concurrent
 * `changePassword()`/`confirmPasswordReset()` committed a new password while
 * this login was running its (~300ms) bcrypt comparison. Never escapes
 * `login`, which converts it into the same generic `invalidCredentials`
 * error every other "these credentials are not valid" outcome returns; a
 * dedicated class (rather than throwing `AppException` directly) is what
 * lets that catch tell this signal apart from a genuine database failure it
 * must not swallow. Mirrors `ChangePasswordRaceLost`'s existing precedent
 * below exactly.
 */
class LoginCredentialSuperseded extends Error {}

/**
 * Sibling of `LoginCredentialSuperseded`: the account was DELETED (not
 * merely re-passworded) between this login's own `User` lookup and its
 * session creation — a concurrent `deleteAccount()`. Kept distinct purely so
 * the audit trail stays truthful; the caller-facing result is the identical
 * generic `invalidCredentials`.
 */
class LoginUserVanished extends Error {}

/**
 * Internal-only rollback signal for `AuthService.changePassword`'s
 * transaction — see that method's doc comment. Thrown INSIDE the
 * `prisma.$transaction` callback when this transaction's own session loses
 * the revoke-all race, purely so `$transaction` rolls back everything the
 * losing attempt touched; always caught inside `changePassword` itself and
 * never surfaces past this file.
 */
class ChangePasswordRaceLost extends Error {}

/** Discriminated result of `changePassword`'s revoke-all-and-rotate transaction. */
type ChangePasswordRotationResult =
  { wonRace: true; response: AuthResponseDto } | { wonRace: false };

/**
 * CANONICAL AUTH LOCK ORDER (Auth lock-order hardening slice).
 * ====================================================================
 *
 * THE INVARIANT — every multi-statement `prisma.$transaction` in this file
 * that mutates account-scoped state MUST acquire a conflicting ROW LOCK on
 * that account's `User` row as its FIRST database statement (see
 * `AuthService.lockAccountRow`), and may only then touch the account's other
 * tables, in this rank:
 *
 *     1. `User`
 *     2. `PasswordResetToken`
 *     3. `Session`
 *     4. `AuthAuditEvent`
 *
 * WHY IT EXISTS — before this slice, the three account-mutating transactions
 * disagreed about which resource they took first, and two of the resulting
 * orderings were exact inversions of each other:
 *
 *     changePassword        Session -> User            (revoke-all, then set hash)
 *     deleteAccount         Session -> User            (revoke-all, then delete row)
 *     confirmPasswordReset  PasswordResetToken -> User -> Session
 *
 * `changePassword`'s `Session -> User` against `confirmPasswordReset`'s
 * `User -> Session`, for the SAME account, is a textbook lock cycle: T1
 * holds every `Session` row and waits for `User`; T2 holds `User` and waits
 * for those `Session` rows. Postgres breaks it by killing one transaction
 * with `40P01 deadlock detected`, which Prisma surfaces as a
 * `PrismaClientUnknownRequestError` that nothing in this file catches — an
 * opaque `500`, not any of the clean race paths these methods carefully
 * define. `deleteAccount` x `confirmPasswordReset` forms the identical
 * cycle. BOTH were reproduced deterministically against real Postgres 16
 * (see the "lock-order" describe block in `auth.service.spec.ts`, whose
 * FIRST test is a positive control that replays these pre-fix statement
 * orders at the raw-SQL level and asserts `40P01` still occurs — so the
 * post-fix tests below it cannot pass vacuously).
 *
 * WHY LOCKING `User` FIRST IS SUFFICIENT — the rank above is not enforced
 * statement-by-statement, and does not need to be. Taking a conflicting
 * `User`-row lock as statement one gives every account-mutating transaction
 * MUTUAL EXCLUSION per account: at most one of them is ever past its first
 * statement for a given `userId`, so two of them can never hold resources
 * the other wants, so no cycle among them can form regardless of what they
 * do afterwards. That is why `deleteAccount`'s closing `DELETE` (which
 * re-touches rank 1 after ranks 3 and 4, and cascades back into ranks 2/3)
 * is safe: every lock it needs is already held by the same transaction, and
 * re-acquiring a held lock never waits.
 *
 * WHY THE REST OF THE FILE CANNOT REOPEN A CYCLE — the only other database
 * work in this auth surface is SINGLE-statement (auto-commit) writes:
 * `logout`/`logoutAll`/`revokeSession`/`refresh`'s CAS and sweeps (`Session`
 * only), `AccountLockoutService`'s upsert (`AccountLockout` only), and
 * `AuthAuditService.emit` (`AuthAuditEvent` only). A single-statement
 * transaction can block, and can be blocked, but it can never hold a lock on
 * one table while waiting on another — so it cannot supply the second edge a
 * cycle needs. The two other multi-statement transactions here both comply
 * with the rank above: `login` takes `User` (`FOR SHARE`) first, then
 * `Session`; `requestPasswordReset` (password-reset invalidation slice —
 * previously a bare auto-commit INSERT) takes `User` (`FOR SHARE`) first,
 * then `PasswordResetToken`, i.e. rank 1 -> rank 2.
 *
 * LOCK MODE — `FOR NO KEY UPDATE` is what `UPDATE "User" SET "passwordHash"`
 * itself takes, so `changePassword`/`confirmPasswordReset` acquire exactly
 * the lock they were going to need anyway, just earlier; it conflicts with
 * `login`'s `FOR SHARE` (the existing, load-bearing superseded-credential
 * guard) and with itself, but NOT with the `FOR KEY SHARE` that a concurrent
 * `Session` INSERT takes for its foreign key — so no unrelated login/refresh
 * is newly blocked. `deleteAccount` uses `FOR UPDATE` instead, matching what
 * its own closing `DELETE` needs; that one does conflict with `FOR KEY
 * SHARE`, which is correct and desirable (a concurrent session INSERT for an
 * account being deleted now waits and then fails cleanly on the foreign key
 * via `isSessionUserForeignKeyViolation`, instead of racing the delete).
 * `login` and `requestPasswordReset` use the weaker `FOR SHARE`: neither
 * writes the `User` row, and both only need to be ORDERED against the three
 * credential mutators — `FOR SHARE` conflicts with `FOR NO KEY UPDATE`/`FOR
 * UPDATE` (so it is), while staying compatible with itself (so two logins,
 * two reset requests, or a login and a reset request for the same account
 * never serialize against each other).
 *
 * THE CREDENTIAL-GENERATION COROLLARY (password-reset invalidation slice).
 * A successful password mutation opens a NEW credential generation, and no
 * recovery artifact minted under the previous one may survive into it:
 * `changePassword` and `confirmPasswordReset` both mark every outstanding
 * `PasswordResetToken` for the account `usedAt` inside the SAME transaction
 * that writes the new `passwordHash`. That guarantee is only as strong as
 * the boundary it is measured against, which is why `requestPasswordReset`
 * had to stop being an unsynchronized auto-commit INSERT: a token inserted
 * while a `changePassword` transaction was mid-flight (after its
 * invalidation statement, before its COMMIT) belonged to the OLD generation
 * yet outlived it. Taking the rank-1 `User` lock first makes every reset
 * token land unambiguously on one side of the boundary — issued strictly
 * before the password change (and therefore invalidated by it) or strictly
 * after it (and therefore legitimately usable).
 *
 * NO RETRY POLICY IS INTRODUCED. This slice removes the cycle; it
 * deliberately does NOT add a `40P01` retry wrapper, and must not — a retry
 * would hide a reintroduced inversion instead of failing loudly on it.
 */
type AccountRowLockMode = 'no-key-update' | 'update' | 'share';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<RootConfig>,
    private readonly accountLockoutService: AccountLockoutService,
    private readonly authAuditService: AuthAuditService,
  ) {}

  /**
   * Acquires the canonical `User`-row lock that every account-mutating
   * transaction in this file must take FIRST — see the "CANONICAL AUTH LOCK
   * ORDER" block above this class for the full rationale and the deadlock it
   * removes.
   *
   * Raw SQL because Prisma's typed client has no way to express a bare
   * `SELECT ... FOR NO KEY UPDATE` / `FOR UPDATE` / `FOR SHARE` row lock.
   * The lock clause
   * is chosen by a closed union (never string-interpolated from input) and
   * `userId` is a bound parameter, so this is not an injection surface.
   * Identifiers are verified against `prisma/schema.prisma` (no
   * `@@map`/`@map`), matching this file's existing `$queryRaw` precedent. No
   * timestamp is read or written, so none of the `AT TIME ZONE 'UTC'`
   * handling the other raw statements need applies here.
   *
   * Returns `false` when the row does not exist — a concurrent
   * `deleteAccount()` removed the account. Every caller maps that to its own
   * already-established "this account is gone" outcome rather than letting a
   * later statement fail with an opaque error.
   */
  private async lockAccountRow(
    tx: Prisma.TransactionClient,
    userId: string,
    mode: AccountRowLockMode,
  ): Promise<boolean> {
    if (mode === 'update') {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
      `;
      return rows.length > 0;
    }

    if (mode === 'share') {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE
      `;
      return rows.length > 0;
    }

    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE
    `;
    return rows.length > 0;
  }

  async register(
    dto: RegisterDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponseDto> {
    // Emails are stored and looked up case-insensitively (normalized to
    // lowercase) even though the `User.email` column itself is a
    // case-sensitive unique constraint: normalizing here ensures
    // "Foo@Bar.com" and "foo@bar.com" are treated as the same account for
    // both duplicate-registration detection and later login lookups.
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new AppException(
        AppErrorCode.EMAIL_ALREADY_REGISTERED,
        'An account with this email already exists',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST_FACTOR);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: dto.displayName,
      },
    });

    // Phase 12, work unit 12A-B3: operational security audit trail
    // (DECISIONS.md "Phase 12 ... approved..." entry, decision 6). Awaited
    // (not fire-and-forget) so the happy path reliably records — but
    // `AuthAuditService.emit` internally catches every failure, so this can
    // never turn a successful registration into a failed HTTP response.
    await this.authAuditService.emit('register_success', {
      userId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return this.issueTokensAndSession(user, context);
  }

  async login(
    dto: LoginDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponseDto> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Always run a bcrypt comparison, even when no user matches the email,
    // against a fixed dummy hash. This keeps the response latency for
    // "email not found" and "wrong password" statistically indistinguishable,
    // defending against timing-based user enumeration. The error thrown
    // below is identical in all cases regardless (wrong password, no such
    // account, or a locked account — see below).
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY,
    );

    if (!user) {
      // No `userId` — this attempt never resolved to a real account, so
      // there is nothing to link the row to. `reason` is a fixed enum
      // value, never the attempted email (see `AUTH_AUDIT_METADATA_ALLOWLIST`).
      await this.authAuditService.emit('login_failed', {
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'user_not_found' },
      });
      throw invalidCredentials();
    }

    // Phase 12, work unit 12A-B1: persistent account lockout (DECISIONS.md
    // "Phase 12 ... approved..." entry, decision 4). This check — and the
    // `AccountLockoutService` calls below — only ever run for an email that
    // already resolved to a real `User` row above, so a nonexistent email
    // never creates or touches lockout state (no enumeration surface). While
    // locked, login is refused with the SAME generic error even if
    // `passwordMatches` is true: a correct password must not unlock the
    // account early or reveal that the password was in fact correct. Note
    // this one extra indexed lookup (present only for existing accounts) is
    // a bounded, deliberately accepted timing signal, dwarfed by the bcrypt
    // comparison above — see this method's existing dummy-hash comment for
    // the same "statistically indistinguishable, not perfectly
    // constant-time" tradeoff already made by this code.
    if (await this.accountLockoutService.isLocked(user.id)) {
      await this.authAuditService.emit('account_locked', {
        userId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw invalidCredentials();
    }

    if (!passwordMatches) {
      await this.accountLockoutService.recordFailure(user.id);
      await this.authAuditService.emit('login_failed', {
        userId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'invalid_password' },
      });
      throw invalidCredentials();
    }

    // Auth test-stability slice, CONFIRMED PRODUCTION RACE (regression test:
    // `auth.service.spec.ts`, "a login() whose authenticated password was
    // replaced by a concurrent changePassword() before its session was
    // created"): `user.passwordHash` was read at the top of this method and
    // the `bcrypt.compare` above takes ~300ms at `BCRYPT_COST_FACTOR = 12`,
    // so a concurrent `changePassword()`/`confirmPasswordReset()` can commit
    // a NEW password — revoking every session for the account as it does —
    // in the window between that read and the `session.create` below. Before
    // this guard, the session created here survived that revoke, because a
    // revoke-all statement cannot possibly match a row that does not exist
    // yet: `changePassword`'s two defensive sweeps both run strictly BEFORE
    // this insert. The account owner's password change therefore did NOT
    // "cut off every other session" — precisely the guarantee
    // `changePassword` exists to provide — for anyone still holding the
    // superseded password.
    //
    // The whole session creation now runs in ONE transaction that first
    // re-reads the account's `passwordHash` `FOR SHARE`. `FOR SHARE`
    // conflicts with the `FOR NO KEY UPDATE` lock Postgres takes for
    // `UPDATE "User" SET "passwordHash" = ...`, which is what makes this
    // deterministic rather than merely narrower:
    //
    //   - If this transaction takes the lock first, the concurrent password
    //     change blocks on `tx.user.update` until this login commits — so
    //     the session created here already exists when that transaction's
    //     final pre-commit sweep runs, and is revoked by it, as intended.
    //   - If the password change takes the lock first, this `SELECT` blocks
    //     until it commits, then re-reads under READ COMMITTED and sees the
    //     NEW hash — the equality predicate fails, no session is created,
    //     and the caller gets the same generic `invalidCredentials` every
    //     other "these credentials are not valid" outcome in this method
    //     returns.
    //
    // No lock-ordering cycle is introduced: this transaction only ever takes
    // a lock on the `User` row and then INSERTs a brand-new `Session` row
    // (an insert conflicts with nothing), whereas `changePassword` locks
    // existing `Session` rows and then the `User` row — it can wait on this
    // transaction, but this transaction never waits on it.
    // Every non-database step (JWT signing, refresh-token generation, HMACs)
    // happens HERE, before the transaction opens, so the transaction below
    // holds its `User` row lock across two statements and nothing else. See
    // `prepareTokenPair`.
    const tokens = await this.prepareTokenPair(user, context);

    let response: AuthResponseDto;
    try {
      response = await this.prisma.$transaction(async (tx) => {
        // Table/column identifiers verified against `prisma/schema.prisma`
        // (no `@@map`/`@map`), matching `changePassword`'s existing raw-SQL
        // precedent in this file. No timestamp is written or compared here, so
        // this statement needs none of that method's `AT TIME ZONE 'UTC'`
        // handling.
        //
        // `FOR SHARE` is LOAD-BEARING, not decorative, and must never be
        // dropped: a plain `SELECT` would read this transaction's own
        // snapshot, still see the OLD hash, and wave the login through. The
        // row lock is what makes the reader either (a) block until the
        // concurrent password change commits and then re-evaluate the
        // predicate against the NEW row version, or (b) win the lock and let
        // the password change block behind it. The predicate selects by `id`
        // only — the hash is compared below, in JS — so a DELETED account
        // (concurrent `deleteAccount`) is distinguishable from a CHANGED
        // password and each gets its own truthful audit reason.
        const [currentCredential] = await tx.$queryRaw<
          { passwordHash: string }[]
        >`
          SELECT "passwordHash" FROM "User"
          WHERE "id" = ${user.id}
          FOR SHARE
        `;

        if (currentCredential === undefined) {
          throw new LoginUserVanished();
        }

        if (currentCredential.passwordHash !== user.passwordHash) {
          throw new LoginCredentialSuperseded();
        }

        // Fix cycle 1 (test-reviewer finding, follow-up to 12C-B1): explicit
        // `invalidCredentials` (this method's own established error for every
        // other "no valid account here" outcome above) for the narrow window
        // where a concurrent `deleteAccount()` deletes this same `user.id`
        // between the check above and `issueTokensAndSession`'s
        // `session.create` — see that method's `onUserVanished` doc comment.
        // The `FOR SHARE` above now also closes that window (a deleted `User`
        // row matches no rows and fails the check first), but this is kept
        // unchanged as defence in depth rather than removed.
        return this.persistSession(user, tokens, tx, invalidCredentials);
      });
    } catch (error) {
      if (error instanceof LoginUserVanished) {
        // A concurrent `deleteAccount()` removed this account mid-flight.
        // Deliberately NOT audited: the `userId` this row would carry no
        // longer references a live `User`, so the insert would itself fail
        // the `AuthAuditEvent_userId_fkey` constraint. The deletion is
        // already recorded by `account_deletion_success`.
        throw invalidCredentials();
      }

      if (!(error instanceof LoginCredentialSuperseded)) {
        // An unrelated database failure still propagates unchanged (and
        // still surfaces as a 500), exactly as before this guard existed —
        // reinterpreting it as "invalid credentials" would trade a visible,
        // diagnosable error for a misleading one.
        throw error;
      }

      // Recorded as a login FAILURE, because that is what the caller gets:
      // the credential presented was valid when this request started and is
      // no longer valid now. `credential_superseded` is an additive value of
      // `login_failed`'s existing `reason` enum (mirroring how
      // `refresh_reuse_detected` distinguishes `already_rotated` from
      // `concurrent_rotation_race`) — no new event name, no new error code,
      // and the client-facing response is the same generic
      // `INVALID_CREDENTIALS` every other failure branch above returns, so
      // this remains no kind of enumeration oracle.
      await this.authAuditService.emit('login_failed', {
        userId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'credential_superseded' },
      });
      throw invalidCredentials();
    }

    // Both of these now run only once the session actually exists. Before the
    // guard above, `recordSuccess` (which clears the failed-login counter)
    // and `login_success` both fired ahead of session creation, so a request
    // that ultimately returned 401 still reset lockout state and left a
    // `login_success` row behind. An audit log that records a successful
    // login which never happened is worse than one that records it a few
    // milliseconds later.
    await this.accountLockoutService.recordSuccess(user.id);

    // Emitted only once the session actually exists. It used to fire before
    // `issueTokensAndSession`, which meant any failure creating the session
    // (the pre-existing concurrent-`deleteAccount` case, and now the
    // superseded-credential case above) left a `login_success` row in the
    // audit trail for a request that returned 401. An audit log that records
    // a successful login which never happened is worse than one that records
    // it a few milliseconds later.
    await this.authAuditService.emit('login_success', {
      userId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return response;
  }

  async refresh(
    refreshToken: string,
    context: AuthRequestContext = {},
  ): Promise<AuthResponseDto> {
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
    });

    if (!session) {
      throw invalidRefreshToken();
    }

    const now = new Date();
    const isReuseOfRevokedToken = session.revokedAt !== null;
    const isExpired = session.expiresAt <= now;

    if (isReuseOfRevokedToken) {
      // A refresh token that was already rotated (or explicitly logged out)
      // being presented again is a strong signal of token theft: either an
      // attacker replayed a stolen token after the legitimate client already
      // rotated it, or a client bug is reusing a stale token. Defensively
      // revoke ALL of this user's other active sessions so a genuinely
      // stolen token chain is fully cut off, not just the one reused token.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      // Phase 12, work unit 12A-B3: `refresh_reuse_detected` (DECISIONS.md
      // "Phase 12 ... approved..." entry, decision 6). Fires from the
      // EXISTING replay-detection logic above — this unit only adds the
      // audit emission, the detection/defensive-revoke behavior itself is
      // unchanged and must stay that way.
      await this.authAuditService.emit('refresh_reuse_detected', {
        userId: session.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'already_rotated' },
      });
      throw invalidRefreshToken();
    }

    if (isExpired) {
      throw invalidRefreshToken();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });

    if (!user) {
      throw invalidRefreshToken();
    }

    // Rotation: revoke the presented session and issue a brand new one
    // rather than updating the existing row in place, so the old refresh
    // token is permanently unusable (and any later reuse of it is detected
    // by the branch above).
    //
    // This is done as a conditional `updateMany` (rather than the earlier
    // `findUnique` → read `revokedAt` → `update` sequence) to close a
    // check-then-act race: if the same refresh token is presented twice
    // concurrently, both requests could otherwise observe `revokedAt: null`
    // before either write lands, and both would independently succeed.
    // `updateMany` with `revokedAt: null` in the `where` clause makes the
    // revoke atomic and conditioned on the row still being unrevoked at the
    // database level, so only one concurrent request can ever flip it. The
    // returned `count` tells us whether this request won that race.
    //
    // Phase 12, work unit 12B-B2: this same statement also stamps
    // `lastUsedAt` on the OLD (about-to-be-revoked) row — this IS the "a
    // session was refreshed" moment decision 6's `Session.lastUsedAt`
    // column exists to capture, distinct from `issueTokensAndSession`
    // stamping it on the brand-new replacement row below. Added to the
    // EXISTING `data` object of the EXISTING conditional `updateMany` (same
    // `where` predicate, same atomicity) rather than a second statement, so
    // this cannot introduce a new race window of its own. Deliberately NOT
    // added to the defensive revoke-all-OTHER-sessions statement a few
    // lines below (`count === 0` branch) or the reuse-detected branch
    // above: those sessions are being defensively cut off, not "used".
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now, lastUsedAt: now },
    });

    if (count === 0) {
      // Someone else (a concurrent request racing on the same token) already
      // revoked this session between our read above and this write. Treat it
      // exactly like the already-revoked/reuse case: cut off all of this
      // user's other active sessions and refuse to issue new tokens.
      await this.prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      // Same event as the reuse-of-revoked-token branch above: from the
      // audit log's perspective, "another request already revoked this
      // session before we could" is the same defensive-revoke-all outcome
      // as a genuinely reused token, just reached via the race window
      // instead of a literal resubmission.
      await this.authAuditService.emit('refresh_reuse_detected', {
        userId: session.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'concurrent_rotation_race' },
      });
      throw invalidRefreshToken();
    }

    // Fix cycle 1 (test-reviewer finding, follow-up to 12C-B1): explicit
    // `invalidRefreshToken` — this method's own established error for every
    // other "this refresh token/session is no longer valid" outcome above
    // (unknown token, reuse of a revoked token, expired, lost the rotation
    // race) — for the narrow window where a concurrent `deleteAccount()`
    // deletes this session's `user.id` between the existence check above and
    // `persistSession`'s `session.create`. See `issueTokensAndSession`'s
    // `onUserVanished` doc comment.
    const tokens = await this.prepareTokenPair(user, context);
    const response = await this.persistSession(
      user,
      tokens,
      this.prisma,
      invalidRefreshToken,
    );

    // Auth test-stability slice, second half of the CONFIRMED PRODUCTION RACE
    // fixed in `login()` (regression test: `auth.service.spec.ts`, "a
    // refresh() that rotated before a concurrent changePassword() committed
    // does not leave a surviving session").
    //
    // The CAS a few lines above (`count === 0`) only proves nobody else
    // revoked the PRESENTED session first. It says nothing about a password
    // change that commits AFTER that CAS but BEFORE the replacement row is
    // inserted — and that window is not small: it spans a committed round
    // trip, an `await`ed `jwtService.signAsync`, `randomBytes`, two HMACs and
    // a second round trip. In that ordering, `changePassword`'s BOTH sweeps
    // run while the replacement session does not yet exist, so neither can
    // possibly match it, and the caller — including an attacker holding a
    // stolen refresh token, which is exactly who a password change is meant
    // to cut off — keeps a live session across the password change.
    //
    // This is a COMPENSATING check rather than a `FOR SHARE` guard like
    // `login`'s, and deliberately so. `refresh` is NOT a transaction: each of
    // its statements above is its own auto-commit write, which is precisely
    // what keeps it outside the lock graph entirely (a single-statement
    // transaction can never hold a lock on one table while waiting on
    // another — see the "CANONICAL AUTH LOCK ORDER" block above this class).
    // Taking a `User` lock here would turn this method into a multi-statement
    // transaction running `Session -> User`, the exact inversion of the
    // canonical order every account-mutating transaction in this file now
    // follows — reintroducing the `40P01` cycle that block exists to remove.
    // Re-reading AFTER the insert takes no locks at all and cannot deadlock,
    // and it is complete rather than merely narrower: the replacement row is
    // committed by the time this read runs, so any password change that
    // commits later is guaranteed to see it and revoke it through its own
    // sweeps.
    const currentCredential = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    if (currentCredential?.passwordHash !== user.passwordHash) {
      // Revokes ONLY the row this call just created — never a blanket
      // revoke-all. The winning `changePassword`/`confirmPasswordReset` has
      // already issued its OWN replacement session for the legitimate caller,
      // and sweeping that away here would reintroduce `changePassword`'s
      // "winner killed by loser" bug.
      await this.prisma.session.updateMany({
        where: { refreshTokenHash: tokens.refreshTokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Same event/reason pair the `count === 0` branch above already uses:
      // decision 7 treats every "this session was revoked out from under a
      // concurrent caller" case identically, so this needs no new audit
      // vocabulary. (A concurrently DELETED account also lands here, via the
      // `?.` — the emit is internally fail-safe, so the now-dangling
      // `userId` cannot turn this into a 500.)
      await this.authAuditService.emit('refresh_reuse_detected', {
        userId: session.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'concurrent_rotation_race' },
      });
      throw invalidRefreshToken();
    }

    return response;
  }

  async logout(refreshToken: string): Promise<void> {
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
    });

    // Idempotent and silent on an unknown/already-revoked token: logout is
    // not a place to reveal whether a given refresh token ever existed.
    if (!session || session.revokedAt) {
      return;
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Looks up a user by id for `GET /auth/me` (Phase 8, work unit 8-B6),
   * called with the `sub` from an already-verified access token
   * (`JwtAuthGuard`). If the user no longer exists (e.g. deleted after the
   * token was issued, since the guard itself does not hit the database),
   * this reuses the same generic invalid-access-token error rather than a
   * distinct "user not found" — the caller presented a token that no longer
   * corresponds to a valid session either way.
   */
  async getUserById(userId: string): Promise<AuthUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new AppException(
        AppErrorCode.INVALID_ACCESS_TOKEN,
        'Invalid or expired access token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? undefined,
    };
  }

  /**
   * Phase 12, work unit 12B-B2: `context` (the same `AuthRequestContext`
   * every public method here already threads through to
   * `AuthAuditService.emit`) is now ALSO used to populate the new additive
   * `Session.userAgent`/`Session.ipHash`/`Session.lastUsedAt` columns
   * (DECISIONS.md "Phase 12 ... approved..." entry, decision 6) on the row
   * this method creates — every call site below (`register`, `login`,
   * `refresh`'s replacement session, `changePassword`'s replacement
   * session) already has a `context` in scope, so this is a pure additive
   * parameter, not a new code path. Reuses the EXACT SAME `hashIp`/
   * `sanitizeUserAgent` primitives `AuthAuditService` uses for
   * `AuthAuditEvent.ipHash`/`userAgent` (`./auth-crypto.ts`) — including the
   * SAME `authAuditIpHashSecret` — so a given raw IP/user-agent value is
   * guaranteed to hash/sanitize identically whether it ends up on an audit
   * row or a session row.
   *
   * Fix cycle 1 (test-reviewer finding, follow-up to work unit 12C-B1):
   * `onUserVanished` lets each caller supply the SAME "user no longer
   * exists" error it already throws for every other version of this
   * condition, for the one additional way it can now surface here — a
   * concurrent `deleteAccount()` deleting `user.id` between this call's own
   * existence check and the `session.create()` below (see
   * `isSessionUserForeignKeyViolation`'s doc comment). Defaults to
   * `invalidCredentials` (matching `register`/`login`'s anti-enumeration
   * posture — a wrong password and a vanished account must stay
   * indistinguishable) since that is the more restrictive of this file's two
   * "user vanished" errors; `refresh()` passes `invalidRefreshToken`
   * explicitly instead, matching what it already throws for every other
   * "this session/user is no longer valid" case a few lines above.
   */
  private async issueTokensAndSession(
    user: Pick<User, 'id' | 'email' | 'displayName'>,
    context: AuthRequestContext = {},
    client: PrismaClientLike = this.prisma,
    onUserVanished: () => AppException = invalidCredentials,
  ): Promise<AuthResponseDto> {
    return this.persistSession(
      user,
      await this.prepareTokenPair(user, context),
      client,
      onUserVanished,
    );
  }

  /**
   * Auth test-stability slice (review finding): the CPU/crypto half of
   * `issueTokensAndSession`, split out so it can run OUTSIDE a transaction.
   *
   * `login()` now creates its session inside a `$transaction` that holds a
   * `FOR SHARE` lock on the caller's `User` row. `jwtService.signAsync` is
   * `await`ed, so leaving it inside that transaction would hold both a
   * database row lock and a pooled connection across an event-loop yield —
   * on the hottest endpoint in the app, and precisely when `bcryptjs`'s
   * cooperative single-threaded hashing is saturating that same event loop.
   * Prisma's default interactive-transaction budget is 5s, so a starved
   * `signAsync` could have turned a successful login into a `P2028` 500, and
   * every concurrent `changePassword`/`confirmPasswordReset`/`deleteAccount`
   * would have waited on a lock held across non-database work.
   *
   * Splitting the method keeps every existing caller's behavior identical
   * (`issueTokensAndSession` above is now just these two calls in sequence)
   * while letting `login` do all crypto first and open a transaction that
   * contains nothing but the guard `SELECT` and the `INSERT`.
   */
  private async prepareTokenPair(
    user: Pick<User, 'id'>,
    context: AuthRequestContext,
  ): Promise<PreparedSessionTokens> {
    const authConfig = this.configService.get('auth', { infer: true })!;

    // Access token payload intentionally carries only the user id (`sub`) —
    // never the password hash or any other sensitive field.
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id },
      { secret: authConfig.jwtAccessSecret, expiresIn: ACCESS_TOKEN_TTL },
    );

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const refreshTokenHash = this.hashRefreshToken(refreshToken);

    // Same "omit entirely (never `undefined`/raw) unless actually supplied"
    // pattern `AuthAuditService.emit` already uses for these same two
    // fields — a unit test calling `AuthService` methods directly (no HTTP
    // request, no `context`) simply gets `null` in both columns, exactly
    // like today.
    const ipHash =
      context.ip !== undefined
        ? hashIp(context.ip, authConfig.authAuditIpHashSecret)
        : undefined;
    const userAgent =
      context.userAgent !== undefined
        ? sanitizeUserAgent(context.userAgent)
        : undefined;

    return {
      accessToken,
      refreshToken,
      refreshTokenHash,
      ipHash,
      userAgent,
    };
  }

  /**
   * The database half of `issueTokensAndSession` — see `prepareTokenPair`
   * above for why the two are separate. Contains exactly one statement, so a
   * caller that wraps it in a transaction holds its locks for the duration
   * of a single INSERT and nothing more.
   */
  private async persistSession(
    user: Pick<User, 'id' | 'email' | 'displayName'>,
    tokens: PreparedSessionTokens,
    client: PrismaClientLike = this.prisma,
    onUserVanished: () => AppException = invalidCredentials,
  ): Promise<AuthResponseDto> {
    const { accessToken, refreshToken, refreshTokenHash, ipHash, userAgent } =
      tokens;
    const now = new Date();

    try {
      await client.session.create({
        data: {
          userId: user.id,
          refreshTokenHash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
          userAgent: userAgent ?? null,
          ipHash: ipHash ?? null,
          // The moment this session slot was (re)issued — see this class's
          // `Session.lastUsedAt` schema doc comment for why "created" and
          // "refreshed" are the only two events that ever touch this column
          // in this codebase's current design.
          lastUsedAt: now,
        },
        select: { id: true },
      });
    } catch (error) {
      // Fix cycle 1 (test-reviewer finding, follow-up to 12C-B1): narrowly
      // catches ONLY the specific FK violation a concurrent `deleteAccount()`
      // can cause (see `isSessionUserForeignKeyViolation`'s doc comment just
      // above this class) and maps it to the caller-supplied "user vanished"
      // error. Deliberately NOT a broad `catch` of every error this
      // statement could throw — an unrelated database failure (connection
      // loss, a genuinely unexpected constraint, etc.) still propagates
      // unchanged and still surfaces as a 500, exactly as before this fix:
      // silently reinterpreting an unrelated failure as "invalid
      // credentials"/"invalid refresh token" would trade a visible,
      // diagnosable error for a much worse, misleading one.
      if (isSessionUserForeignKeyViolation(error)) {
        throw onUserVanished();
      }
      throw error;
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? undefined,
      },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Phase 12, work unit 12B-B1: `POST /auth/change-password` (DECISIONS.md
   * "Phase 12 ... approved..." entry, decision 7). Re-verifies the caller's
   * CURRENT password server-side, then on success revokes every OTHER
   * session for the account while rotating the current session's own token
   * pair — the calling device stays authenticated with fresh credentials
   * instead of being logged out by its own action.
   *
   * "The current session" cannot be read off the access token: its payload
   * is `{ sub }` only (see `auth.types.ts`) — there is no session-id claim,
   * and adding one is a wider change than this work unit (it would alter the
   * token contract mobile already depends on). So, exactly like
   * `POST /auth/refresh` and `POST /auth/logout` already do via
   * `RefreshTokenDto`, the caller's current plaintext refresh token is
   * supplied in the request body and used to look up its `Session` row by
   * `refreshTokenHash` — that row IS "the current session."
   *
   * Race-safety mirrors `refresh()`'s existing rotation in SPIRIT (a
   * compare-and-swap conditioned on `revokedAt: null`) but NOT in mechanics:
   * `refresh()` only ever touches ONE session row, so a simple CAS on that
   * one row is race-safe on its own. This method must revoke the current
   * session AND every other active session for the account in the SAME
   * operation, and originally did that as two separate `updateMany` calls (a
   * CAS on just the current session, then a broad revoke of the rest). That
   * was a lock-ordering bug: when an account has two different active
   * sessions and both call `change-password` concurrently, one transaction
   * locks session A first (its own CAS) then tries to lock session B (the
   * broad revoke), while the other locks B first then tries to lock A —
   * Postgres detects the cycle and kills one transaction with `40P01
   * deadlock detected`, an unhandled `PrismaClientUnknownRequestError` that
   * surfaces as an opaque `500` instead of the intended clean race path.
   *
   * The fix is a SINGLE statement over ALL of the account's non-revoked
   * sessions, including the current one (`WHERE "userId" = ... AND
   * "revokedAt" IS NULL`). Two transactions issuing the identical statement
   * scan and lock rows in the same order, so there is no cross-wait cycle to
   * deadlock on: whichever transaction gets there first revokes everything;
   * the other blocks on the first row, then (under READ COMMITTED, the
   * isolation level this app uses) re-evaluates `revokedAt IS NULL` per row
   * once it acquires the lock and finds nothing left to touch.
   *
   * A fix-cycle-1 revision briefly bounded this statement with `createdAt: {
   * lte: now }` to stop a slower loser from sweeping up a faster winner's
   * brand-new replacement session (see below). That bound was itself a
   * CRITICAL bug (fix-cycle-2 finding): `now` is captured before both bcrypt
   * calls in this method, so ANY session created after that point —
   * including one created by a completely unrelated concurrent `login()`
   * call using the still-valid CURRENT password — was structurally excluded
   * from the revoke, and survived the password change permanently. A
   * wall-clock cutoff cannot distinguish "a session this transaction should
   * legitimately spare" from "a session that happens to have been created a
   * few hundred milliseconds late" — both look identical to a `createdAt`
   * comparison. This revision removes the bound entirely and replaces the
   * win/loss mechanism with a POSITIVE identifier instead:
   *
   * The statement is issued as raw SQL (`tx.$queryRaw`, on the `tx` client so
   * it participates in the surrounding transaction, never a fresh
   * connection) specifically so it can carry a `RETURNING "id"` clause —
   * Prisma's `updateMany` has no equivalent. The set of ids it returns is
   * EXACTLY the set of sessions THIS transaction's own write revoked, at the
   * instant it ran, with nothing excluded by time. Win/loss is then simply:
   * is the current session's id a member of that returned set? This is
   * collision-proof (session ids are unique `cuid`s, not 1ms-resolution
   * `Date` objects) and replaces the fix-cycle-1 wall-clock-equality check
   * (`revokedAt.getTime() === now.getTime()`), which two genuinely
   * concurrent transactions capturing the identical millisecond could in
   * theory both satisfy.
   *
   * On a LOSS, the transaction callback THROWS (a private, internal-only
   * `ChangePasswordRaceLost` signal — never surfaced past this method)
   * instead of returning a "we lost" value. Returning normally would COMMIT
   * whatever this losing transaction's own revoke-all statement touched;
   * throwing forces Prisma to ROLL BACK it instead. That matters because the
   * very same broad, unconditioned `WHERE "revokedAt" IS NULL` predicate that
   * fixes the CRITICAL above can, on the losing side of a two-different-
   * active-sessions race, legitimately match a session it should NOT keep:
   * if this transaction's UPDATE happens to run (or is unblocked) AFTER the
   * winning transaction has already committed its brand-new replacement
   * session, that new session now genuinely has `revokedAt IS NULL` and the
   * same `userId`, so the losing statement WOULD revoke it too. Throwing (and
   * thus rolling back) undoes that collateral revoke unconditionally, closing
   * fix-cycle-1's original "winner killed by loser" bug WITHOUT needing any
   * time bound — the loss is detected by the id-membership check either way,
   * and rollback erases whatever the losing statement touched regardless of
   * which rows those happened to be.
   *
   * The whole rotation (the single revoke-all-with-`RETURNING` + the password
   * update + creation of the replacement session) runs inside ONE
   * `prisma.$transaction`, so the account is never observably left with zero
   * valid sessions, and the password is never changed if the current session
   * turns out to have lost its race. Losing that race is treated exactly
   * like `refresh()`'s existing `concurrent_rotation_race` branch: every
   * other active session that existed at the moment the WINNING transaction
   * ran is defensively revoked (via that transaction's own commit — there is
   * deliberately no second, non-transactional revoke-all bolted on after a
   * loss here; see above for why that would reintroduce exactly the bug this
   * fixes) and the same `refresh_reuse_detected` audit event is emitted — no
   * new error code or event type needed. Because the current session is
   * REVOKED (not deleted) here, exactly like a normal `refresh()` rotation,
   * later reuse of the pre-change-password refresh token via `POST
   * /auth/refresh` is caught by that endpoint's existing, UNCHANGED
   * `isReuseOfRevokedToken` replay-detection branch — nothing in this method
   * needs to duplicate that logic.
   *
   * On the WINNING path only, a second, purely additive sweep runs
   * immediately before the transaction commits (after the password update and
   * the replacement session are created), using the SAME unconditioned
   * `revokedAt IS NULL` predicate, excluding only the just-created
   * replacement session. This exists because the two sweeps described above
   * already close the deadlock and the winner-killed-by-loser bug, but do NOT
   * by themselves guarantee zero survivors against a FULLY UNRELATED
   * concurrent caller — most notably `login()` racing this account's
   * still-valid CURRENT password at the exact moment `changePassword` runs.
   * Measured empirically against real Postgres: with only the first sweep,
   * such a race left a surviving extra active session in a small but real
   * fraction of runs, because `bcryptjs`'s cooperative, single-threaded
   * chunked hashing does not reliably guarantee that `changePassword`'s two
   * bcrypt calls finish after `login`'s one — the two can complete in either
   * order. Running the identical sweep again right before commit closes that
   * residual window down to (empirically, ≥25 real, no-artificial-delay
   * iterations) zero observed survivors.
   *
   * Clock-source note (advisory finding, fix cycle 2): `now` (a Node
   * `new Date()`) is no longer compared against any Postgres-generated
   * timestamp (`Session.createdAt`/`revokedAt`) to decide a race outcome —
   * the id-membership check above is what decides wins/losses, not a
   * timestamp comparison, so app-vs-DB clock coherence cannot affect
   * correctness here. `now` is still used for two things, neither of which
   * is a correctness-affecting app/DB clock comparison: (1) the VALUE written
   * into `revokedAt` (any value works — nothing compares it back), and (2)
   * the pre-existing, unchanged `currentSession.expiresAt > now` usability
   * check a few lines below, which compares a Node timestamp against a
   * Postgres-generated `expiresAt` the same way `refresh()` already does
   * elsewhere in this file — not new to this fix, and not part of this
   * finding.
   *
   * OUTSTANDING RESET TOKENS ARE INVALIDATED (password-reset invalidation
   * slice). A successful password change opens a new credential generation,
   * so every still-usable `PasswordResetToken` for this account is marked
   * `usedAt` inside the SAME transaction that writes the new hash — see the
   * "CREDENTIAL-GENERATION COROLLARY" in the canonical lock-order block
   * above this class. Before this slice a reset token issued BEFORE a
   * successful change survived it and could still replace the brand-new
   * password afterwards; that was a deliberate, documented carve-out of the
   * lock-order slice (a policy question it was not scoped to settle), and
   * this slice settles it in favour of the stronger invariant.
   *
   * Three properties of the placement are load-bearing:
   *   1. It runs INSIDE the transaction, AFTER the `User` row lock (rank 1
   *      -> rank 2 of the canonical order) and after `bcrypt.compare` has
   *      already accepted `currentPassword` outside it. A FAILED password
   *      change — wrong current password, unusable refresh token, a lost
   *      revoke-all race — therefore never invalidates anything: the first
   *      two throw before the transaction opens at all, and the third throws
   *      `ChangePasswordRaceLost` inside it, which rolls this statement back
   *      along with everything else the losing attempt touched.
   *   2. The predicate is `usedAt IS NULL AND expiresAt > now` — the same
   *      "currently usable" set `confirmPasswordReset`'s own claim statement
   *      targets. An ALREADY-expired token is deliberately left untouched:
   *      it is unusable either way, and stamping `usedAt` on it would
   *      silently reclassify a later confirm's audit `reason` from `expired`
   *      to `already_used` for no security gain. `now` is this method's
   *      existing pre-bcrypt timestamp, so the predicate is evaluated
   *      against an instant slightly EARLIER than the commit — which WIDENS
   *      the invalidated set (a token expiring during the ~600ms bcrypt
   *      window is swept too) rather than narrowing it. That is the safe
   *      direction: it can never leave a still-usable token behind.
   *   3. It is a plain `updateMany`, not raw SQL. Nothing here needs a
   *      `RETURNING` clause (unlike the session revoke below, whose id set
   *      decides a race), and the ORM writes/compares `usedAt`/`expiresAt`
   *      in correct UTC without the `AT TIME ZONE 'UTC'` handling every raw
   *      statement in this file needs.
   *
   * NO NEW AUDIT EVENT is emitted for the invalidation. It is a side effect
   * of `change_password_success`, not an independent operation, and one
   * `AuthAuditEvent` row per revoked token would be noise that also leaks
   * how many reset requests an account had outstanding. A later confirm of
   * such a token is already recorded by the existing
   * `password_reset_confirm_failed` / `already_used` path, and the
   * caller-facing error stays the identical generic
   * `INVALID_PASSWORD_RESET_TOKEN` used for unknown/expired/used tokens — a
   * reset token that was killed by a password change must not be
   * distinguishable from any other invalid one.
   *
   * This route has no dedicated `AccountLockoutService` coupling and no
   * `@Throttle()` override (see the paragraph below and the controller),
   * so a caller holding a stolen-but-still-valid access token could attempt
   * up to the app-wide default throttle limit's worth of `currentPassword`
   * guesses per window, slowed only by bcrypt. This is a known, deliberately
   * DEFERRED product/security decision (not mandated by decision 7 or the
   * frozen acceptance criteria for this work unit) — flagged here so it is
   * visible for a future, explicitly-scoped work unit rather than fixed
   * unilaterally by this one.
   *
   * A wrong `currentPassword` is refused with the SAME generic
   * `INVALID_CREDENTIALS` error `login` uses (no distinct code — this is an
   * authenticated endpoint already scoped to the caller's own account, so
   * there is no email-enumeration concern, but the error still should not
   * become an oracle for "your password is close" or similar). This
   * codebase's only re-authentication precedent, `AccountLockoutService`, is
   * wired EXCLUSIVELY into `login` (keyed off a not-yet-authenticated email
   * lookup) — there is no established pattern for coupling authenticated
   * re-auth (a caller who already holds a valid access token) into that same
   * lockout state, so this deliberately does NOT invent one; a wrong
   * `currentPassword` here fails cleanly and only emits the
   * `change_password_failed` audit event below.
   *
   * A refresh token that does not resolve to a session, or resolves to a
   * session belonging to a DIFFERENT user (a cross-account/IDOR attempt), or
   * is already revoked/expired, is rejected with the SAME generic
   * `INVALID_REFRESH_TOKEN` error `refresh()` uses for its equivalent
   * failure modes — this makes a cross-account attempt impossible (the
   * lookup is always scoped to `session.userId === userId`, never trusting
   * the client-supplied token alone) without leaking which specific reason
   * caused the rejection.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponseDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      // The access token verified fine (this method is only ever reached via
      // `JwtAuthGuard`), but its `sub` no longer resolves to a real user
      // (e.g. deleted since the token was issued) — mirrors `getUserById`'s
      // existing precedent for this exact situation.
      throw new AppException(
        AppErrorCode.INVALID_ACCESS_TOKEN,
        'Invalid or expired access token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const refreshTokenHash = this.hashRefreshToken(dto.refreshToken);
    const currentSession = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
    });

    const now = new Date();
    const isCurrentSessionUsable =
      currentSession !== null &&
      // IDOR-safe: a refresh token that happens to hash-match but belongs to
      // a DIFFERENT account is never treated as "the current session" —
      // this is what makes a cross-account attempt impossible rather than
      // merely unlikely.
      currentSession.userId === userId &&
      currentSession.revokedAt === null &&
      currentSession.expiresAt > now;

    if (!isCurrentSessionUsable) {
      throw invalidRefreshToken();
    }

    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );

    if (!passwordMatches) {
      await this.authAuditService.emit('change_password_failed', {
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'invalid_current_password' },
      });
      throw invalidCredentials();
    }

    const newPasswordHash = await bcrypt.hash(
      dto.newPassword,
      BCRYPT_COST_FACTOR,
    );

    // Auth lock-order hardening slice: the replacement session's access
    // token (`jwtService.signAsync`, an `await`ed, event-loop-yielding call),
    // its refresh token (`randomBytes`) and both HMACs are computed HERE,
    // BEFORE the transaction opens — mirroring what `login()` already does
    // for the identical reason (see `prepareTokenPair`). Previously this
    // whole block ran INSIDE the transaction via `issueTokensAndSession`,
    // which was already undesirable (a `Session` row lock held across
    // non-database work, on a path where `bcryptjs` is saturating the same
    // single-threaded event loop) and becomes unacceptable now that the
    // transaction below opens by locking the account's `User` row: every
    // concurrent `confirmPasswordReset`/`deleteAccount`/`login` for this
    // account would queue behind a JWT signature. The transaction is now
    // pure database work, start to finish.
    const tokens = await this.prepareTokenPair(user, context);

    let rotation: ChangePasswordRotationResult;
    try {
      rotation = await this.prisma.$transaction(async (tx) => {
        // CANONICAL AUTH LOCK ORDER, step 1 (see the block above this class):
        // take the account's `User` row lock BEFORE touching `Session`. This
        // is the whole fix for the `changePassword` x `confirmPasswordReset`
        // `40P01` cycle: this method used to run `Session -> User` while
        // `confirmPasswordReset` ran `User -> Session`, so for one account
        // each transaction could end up holding exactly what the other was
        // waiting for. `FOR NO KEY UPDATE` is the same lock `tx.user.update`
        // a few statements below takes anyway — acquiring it up front costs
        // nothing extra and makes at most one account-mutating transaction
        // per account able to proceed past this line.
        if (!(await this.lockAccountRow(tx, userId, 'no-key-update'))) {
          // A concurrent `deleteAccount()` removed the account between this
          // method's own `findUnique` above and this lock. Same error the
          // top of this method already throws for "the token verified but
          // its `sub` no longer resolves to a real user" — not a new
          // outcome, just the same one reached a few statements later.
          throw new AppException(
            AppErrorCode.INVALID_ACCESS_TOKEN,
            'Invalid or expired access token',
            HttpStatus.UNAUTHORIZED,
          );
        }

        // CANONICAL AUTH LOCK ORDER, step 2 (`PasswordResetToken`): every
        // still-usable password-reset token for this account dies with the
        // old password. See this method's doc comment ("OUTSTANDING RESET
        // TOKENS ARE INVALIDATED") for why this sits here specifically —
        // after the `User` lock and after `currentPassword` was accepted,
        // inside the transaction so a rolled-back change un-invalidates
        // them, and scoped to the same "currently usable" predicate
        // `confirmPasswordReset`'s claim statement uses.
        //
        // `updateMany`'s count is deliberately ignored: unlike the session
        // revoke below, nothing about this statement decides a race. An
        // account with no outstanding tokens matches zero rows, which is the
        // overwhelmingly common case and a no-op, not a failure.
        await tx.passwordResetToken.updateMany({
          where: { userId, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });

        // SINGLE raw-SQL statement revoking every non-revoked session for the
        // account, INCLUDING the current one — see this method's doc comment
        // for why this must be one statement (not a CAS-on-current followed
        // by a separate broad revoke): two separate statements with
        // different WHERE predicates let two concurrent `change-password`
        // calls for two DIFFERENT active sessions of the same account lock
        // rows in opposite orders and deadlock (`40P01`). One statement with
        // an IDENTICAL predicate in both transactions removes the
        // lock-ordering cycle. Deliberately NO `createdAt` bound — see the
        // doc comment above for why a wall-clock cutoff here is itself a
        // CRITICAL bug (it let a same-account session created moments later,
        // by anyone, survive the revoke permanently).
        //
        // Raw SQL (via `tx.$queryRaw`, on the `tx` client so this
        // participates in the surrounding transaction rather than escaping
        // it onto a fresh connection) is used specifically for the
        // `RETURNING "id"` clause, which Prisma's `updateMany` has no
        // equivalent for. Table/column identifiers below are verified
        // against `prisma/schema.prisma` (no `@@map`/`@map`, so Prisma's
        // generated migration SQL — see
        // `prisma/migrations/20260723055428_init_postgresql/migration.sql`
        // — uses the exact-cased, quoted identifiers reproduced here:
        // `"Session"`, `"userId"`, `"revokedAt"`, `"id"`).
        //
        // `AT TIME ZONE 'UTC'` on the write (`${now}`) side is REQUIRED, not
        // decorative (Phase 12, work unit 12D-B0 — this was a CRITICAL
        // defect from 12B-B1 until fixed here). `"revokedAt"` is a
        // `timestamp(3) WITHOUT time zone` column, and Prisma's own ORM
        // writes UTC wall-clock digits into it everywhere else in this file
        // (e.g. the `tx.session.updateMany({ data: { revokedAt: ... } })`
        // calls a few lines below and in `refresh`/`logoutAll`/etc.). A raw
        // `$queryRaw` `Date` parameter, in contrast, binds as `timestamptz`;
        // assigning it directly to a naive column makes Postgres silently
        // reinterpret it using the DATABASE SESSION'S configured `TimeZone`
        // (NOT necessarily UTC — this project's Postgres instance is
        // `Asia/Jakarta`, UTC+7, confirmed via `SHOW TimeZone`), corrupting
        // the stored value by that offset. `AT TIME ZONE 'UTC'` pins the
        // conversion to UTC explicitly, matching what the ORM already does
        // everywhere else in this codebase, and mirrors the identical idiom
        // used by `confirmPasswordReset`'s `"usedAt" = ${now} AT TIME ZONE
        // 'UTC'` and `AccountLockoutService.recordFailure`'s `(${now} AT
        // TIME ZONE 'UTC')` below. The predicate
        // (`WHERE "userId" = ... AND "revokedAt" IS NULL`) is UNCHANGED —
        // this fix is scoped strictly to the timezone handling of the value
        // written, not the statement shape 12B-B1 fought 3 fix cycles to
        // land (see this method's doc comment above for why that shape is
        // load-bearing for deadlock-safety and race-resolution).
        const revokedSessions = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "Session"
          SET "revokedAt" = ${now} AT TIME ZONE 'UTC'
          WHERE "userId" = ${userId} AND "revokedAt" IS NULL
          RETURNING "id"
        `;

        // The set of ids returned above is EXACTLY the set of sessions THIS
        // transaction's own write just revoked — a positive, collision-proof
        // identifier (session ids are unique `cuid`s), unlike the fix-cycle-1
        // wall-clock-equality check this replaces
        // (`revokedAt.getTime() === now.getTime()`), which two genuinely
        // concurrent transactions capturing the identical millisecond could
        // in theory both satisfy. "We won" is simply: is our current
        // session's id a member of the set we just revoked?
        const wonRace = revokedSessions.some(
          (row) => row.id === currentSession.id,
        );

        if (!wonRace) {
          // Throwing (rather than returning a "we lost" value) forces this
          // `$transaction` to ROLL BACK, undoing whatever the statement
          // above touched. That matters because the same unconditioned
          // `revokedAt IS NULL` predicate that fixes the CRITICAL above can,
          // on the losing side of a two-different-active-sessions race,
          // legitimately match a session it must NOT keep: if this
          // statement runs (or is unblocked) after some OTHER transaction
          // already committed its own brand-new replacement session, that
          // new session now genuinely matches this WHERE clause too. Rolling
          // back unconditionally erases any such collateral revoke,
          // regardless of which rows it happened to touch — closing
          // fix-cycle-1's "winner killed by loser" bug without needing a
          // time bound. See this method's doc comment for the full
          // reasoning.
          throw new ChangePasswordRaceLost();
        }

        await tx.user.update({
          where: { id: userId },
          data: { passwordHash: newPasswordHash },
        });

        // Issues the replacement token pair for the SAME session slot,
        // inside this same transaction — the account is never observably
        // left with zero valid sessions between the revoke above and this
        // create. Passes `context` through (Phase 12, work unit 12B-B2) so
        // the replacement session's `userAgent`/`ipHash`/`lastUsedAt` are
        // populated exactly like any other freshly issued session.
        const response = await this.persistSession(user, tokens, tx);

        // Final defensive sweep, still inside the SAME (winning) transaction,
        // immediately before it commits: catches the narrow remaining window
        // between the revoke-all statement above and this point where a
        // fully UNRELATED concurrent call — most notably `login()` racing
        // this account's still-valid CURRENT password — could complete its
        // own session creation. Measured empirically: with only the single
        // sweep above, a real concurrent `login()`-with-old-password race
        // left a surviving second active session in a small but real
        // fraction of runs (bcryptjs's cooperative, single-threaded chunked
        // hashing makes "changePassword does two bcrypt calls, login only
        // does one" an unreliable ordering guarantee — the two can finish in
        // either order). This sweep uses the SAME unconditioned `revokedAt
        // IS NULL` predicate (no `createdAt` bound — the CRITICAL this
        // method's doc comment describes), excluding only the replacement
        // session just created above (by the `refreshTokenHash` already
        // computed outside this transaction — no extra round trip needed to
        // look its id up). It is NOT a second win/loss check (that was
        // already decided above); it is purely additive cleanup, so its
        // `count` is intentionally ignored.
        await tx.session.updateMany({
          where: {
            userId,
            revokedAt: null,
            refreshTokenHash: { not: tokens.refreshTokenHash },
          },
          data: { revokedAt: new Date() },
        });

        return { wonRace: true as const, response };
      });
    } catch (error) {
      if (!(error instanceof ChangePasswordRaceLost)) {
        throw error;
      }
      rotation = { wonRace: false as const };
    }

    if (!rotation.wonRace) {
      // Lost the race: something else already revoked this exact session
      // before our transaction's revoke-all statement ran — a concurrent
      // `refresh()` call, a second concurrent `change-password` call reusing
      // the same current refresh token, OR a second concurrent
      // `change-password` call for a DIFFERENT active session of this same
      // account (that call's own revoke-all-sessions statement reached and
      // revoked THIS session first). Treated exactly like `refresh()`'s
      // existing `concurrent_rotation_race` branch. No separate,
      // non-transactional revoke-all is issued here (unlike fix cycle 1):
      // the transaction above already rolled back, so the password change
      // was never applied — whichever transaction actually WON this race
      // already revoked every other session for the account (twice, in
      // fact — see the two sweeps in the winning branch above) as part of
      // its own commit; a second, un-rollback-able revoke bolted on here
      // would reintroduce exactly the "winner killed by loser" bug this fix
      // closes (it could revoke a winner's brand-new session with no way to
      // undo it).
      // Note: a legitimate concurrent `refresh()` call that loses its
      // session to a `change-password` call's revoke-all is labeled with the
      // same `refresh_reuse_detected` event / `concurrent_rotation_race`
      // reason a genuine stolen-token replay would be — this is expected
      // (decision 7 treats every "session revoked out from under a
      // concurrent caller" case identically), not a bug in the audit trail.
      await this.authAuditService.emit('refresh_reuse_detected', {
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'concurrent_rotation_race' },
      });
      throw invalidRefreshToken();
    }

    await this.authAuditService.emit('change_password_success', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return rotation.response;
  }

  /**
   * Phase 12, work unit 12B-B2: `POST /auth/logout-all` (DECISIONS.md
   * "Phase 12 ... approved..." entry, decision 6; the exact "which
   * sessions" semantic is this work unit's own explicit, binding
   * resolution of the runbook's flagged ambiguity — see
   * `AuthController.logoutAll`'s doc comment, which is the canonical
   * statement of the contract, and the README).
   *
   * FROZEN CONTRACT: revokes EVERY session for the account, INCLUDING the
   * one the caller used to make this very request — there is no
   * "current session" carve-out here (unlike `changePassword`, which
   * deliberately keeps the calling device logged in with rotated
   * credentials). "Log out everywhere" logging out the calling device too
   * is the whole point of a SEPARATE endpoint from `changePassword`: the
   * "revoke others but keep me signed in" need is already served by
   * `changePassword`'s existing behavior, so this endpoint does not need to
   * (and must not) replicate it.
   *
   * A single unconditioned `updateMany` (no per-row CAS/id-membership dance
   * like `changePassword`'s transaction) is sufficient here: unlike
   * `changePassword`, this method never creates a replacement session in
   * the same operation, so there is no "did MY OWN write win a race against
   * itself" question to answer — every concurrent caller's `updateMany`
   * converges on the same end state (every session revoked), and Postgres
   * needs no special lock-ordering care for that outcome.
   *
   * Note on the access token: this app's access tokens are stateless JWTs,
   * verified by `JwtAuthGuard` without any database lookup (see that
   * guard's doc comment). Revoking every `Session` row here immediately
   * invalidates every REFRESH token for the account (any subsequent
   * `POST /auth/refresh` attempt fails, exactly like a normal revoke), but
   * an access token issued before this call remains verifiable until it
   * naturally expires (~15 min) — this is the SAME pre-existing limitation
   * `POST /auth/logout` already has today, not a new gap introduced here,
   * and out of scope for this endpoint's frozen contract to fix.
   */
  async logoutAll(
    userId: string,
    context: AuthRequestContext = {},
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.authAuditService.emit('logout_all_success', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Phase 12, work unit 12B-B2: `GET /auth/sessions`. Lists only the
   * CALLER'S OWN currently-active (`revokedAt: null`) sessions — an explicit
   * Prisma `select` is used (not a blanket `findMany` + manual field
   * stripping) specifically so `refreshTokenHash`/`ipHash` are never even
   * fetched from the database in the first place, not merely omitted when
   * building the response — defense in depth against a future accidental
   * `JSON.stringify(session)`-style leak. Revoked sessions are deliberately
   * excluded: this is a "manage your logged-in devices" surface, and a
   * revoked/rotated-out session is no longer a device the caller can act on
   * (there is nothing a `DELETE /auth/sessions/:id` on it could usefully do
   * that hasn't already happened). `expiresAt` is included (per this work
   * unit's frozen response shape) so a client can itself judge staleness
   * for a session that is technically still `revokedAt: null` but already
   * past its TTL, without this endpoint needing its own opinion on that.
   */
  async listSessions(userId: string): Promise<SessionSummaryDto[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    }));
  }

  /**
   * Phase 12, work unit 12B-B2: `DELETE /auth/sessions/:id`. Ownership-scoped
   * revoke — a session id that does not exist at all, and a session id that
   * exists but belongs to a DIFFERENT account, are refused with the EXACT
   * SAME `SESSION_NOT_FOUND`/404 (see that error code's doc comment) so a
   * cross-account revoke is impossible, not merely unlikely, and so a
   * caller cannot use this endpoint to probe which session ids exist for
   * other accounts. The initial ownership lookup only ever selects `id`/
   * `userId` — `refreshTokenHash`/`ipHash` are never fetched here either.
   *
   * The actual revoke is a conditional `updateMany` (`id` + `userId` +
   * `revokedAt: null` all in the `WHERE` clause, mirroring `refresh()`'s
   * existing CAS pattern) rather than a plain `update` on the row read
   * above, so a session already revoked by something else between the
   * lookup and this write (another concurrent `DELETE` for the same id,
   * `logout()`, `refresh()`'s rotation, `logoutAll`, ...) is a safe,
   * idempotent no-op — mirroring `AuthService.logout`'s existing
   * idempotent-on-already-revoked precedent — rather than a spurious
   * "not found" or an unnecessary second write. The audit event only fires
   * when this call actually performed the revoke (`count > 0`), not on the
   * idempotent no-op path, to avoid double-logging one real revoke.
   */
  async revokeSession(
    userId: string,
    sessionId: string,
    context: AuthRequestContext = {},
  ): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });

    if (!session || session.userId !== userId) {
      throw new AppException(
        AppErrorCode.SESSION_NOT_FOUND,
        'Session not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (count > 0) {
      await this.authAuditService.emit('session_revoked', {
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
      });
    }
  }

  /**
   * Phase 12, work unit 12B-B3: `POST /auth/password-reset/request`
   * (DECISIONS.md "Phase 12 ... approved..." entry, decision 3).
   *
   * FROZEN CONTRACT: always resolves successfully, with the same status and
   * body shape, regardless of whether `dto.email` resolves to a real
   * account — mirroring `AuthService.login`'s existing anti-enumeration
   * precedent, applied here at the "does this email exist" layer instead of
   * "is this password correct". The ONE field that can legitimately differ
   * is `devToken` (see `PasswordResetRequestResponseDto`'s doc comment),
   * which is gated on `DEV_TOOLS_ENABLED`, not on account existence per se —
   * though in practice it can only ever be populated when an account WAS
   * resolved, since there is no token to return otherwise.
   *
   * No `PasswordResetToken` row is ever created for an email that does not
   * resolve to a real `User` — mirroring `AccountLockout`'s existing
   * "a nonexistent email never causes a row to be created" precedent (see
   * that model's schema doc comment) — so this table can never be used to
   * enumerate which emails are registered, even with raw DB access. The raw
   * token itself is still generated (and its hash computed) unconditionally
   * before the existence check branches, purely so the "email exists" and
   * "email does not exist" code paths perform the same CPU work either way
   * — the generated value is simply discarded, never persisted, when no
   * account resolves.
   *
   * Fix cycle 1 (review finding 1 — timing oracle): the CPU-work parity
   * above narrowed, but did not close, a measurable timing gap. The
   * existing-account branch performs ONE extra `PasswordResetToken` INSERT
   * (`passwordResetToken.create`, below) that the not-found branch never
   * did, and that single extra write — not the CPU work, which was already
   * balanced — was the actual, measured (~0.5-0.7ms, stable across 100+
   * samples/branch, 5 independent runs) oracle. Mirrors
   * `AuthService.login`'s existing dummy-hash precedent (see its doc
   * comment) but for the DATABASE-WRITE dimension instead of the CPU one:
   * the not-found branch below now issues its own real, unconditional
   * statement against the SAME `PasswordResetToken` table — a `deleteMany`
   * keyed on the very `tokenHash` just generated above. That hash can never
   * match a real row (it is derived from bytes generated fresh, in-process,
   * this call only, and never persisted anywhere before this point), so the
   * statement is GUARANTEED to affect zero rows every time — it creates
   * nothing, leaks nothing, and leaves no residue to accumulate, while still
   * making both branches perform one write-shaped round trip to the same
   * table. This narrows (the reviewer's own words: "a residual sub-0.2ms gap
   * is acceptable — report honestly rather than overclaiming constant
   * time") rather than mathematically eliminates the remaining gap, exactly
   * like `AuthService.login`'s own dummy-hash comment already accepts for
   * its own extra lockout lookup.
   *
   * THE CREDENTIAL-GENERATION BOUNDARY (password-reset invalidation slice).
   * This method used to persist its token with a bare auto-commit INSERT
   * that took no account-level lock at all. Once `changePassword` began
   * invalidating outstanding tokens (see its doc comment), that left a real
   * gap: an INSERT committing in the window between a `changePassword`
   * transaction's invalidation statement and its COMMIT produced a token
   * that was issued while the OLD password was still current, yet survived
   * the change — landing on the wrong side of the boundary the invalidation
   * exists to draw. A wall-clock/`createdAt` comparison cannot close that
   * (see `changePassword`'s doc comment for why time bounds were already
   * rejected there as a CRITICAL defect), so the INSERT now runs inside a
   * two-statement transaction that takes the canonical rank-1 `User` row
   * lock first — `FOR SHARE`, the same mode `login` uses, because this
   * method does not write the `User` row and only needs to be ORDERED
   * against the three credential mutators, never against other logins or
   * other reset requests. Every token is therefore committed strictly
   * before a password change (and invalidated by it) or strictly after it
   * (and legitimately usable). Lock order is rank 1 -> rank 2, which cannot
   * form a cycle with anything (see the canonical block above this class).
   *
   * Two consequences of that lock, both improvements rather than costs:
   * a concurrent `deleteAccount()` can no longer make this method's INSERT
   * fail with a raw foreign-key `P2003`/500 (the lock resolves first, the
   * row is gone, and the request takes the SAME no-account path an unknown
   * email takes), and the timing-parity write on the no-account path is now
   * itself a two-statement transaction of the identical shape, so the
   * branches still issue the same number of round trips to the same table
   * — the parity property this method's fix cycle 1 established is
   * preserved, not silently regressed by the new transaction.
   *
   * Where the dev-only conditional lives — a route guard, or the
   * response-shaping? Deliberately the LATTER, not `DevToolsGuard`: that
   * guard REJECTS the entire route (404 `DEV_TOOLS_DISABLED`) whenever the
   * flag is off, which is the correct behavior for a route that must be
   * UNREACHABLE outside dev (e.g. the dev-only entitlement grant/revoke
   * routes) — but this route's frozen contract requires it to always
   * respond `202`, in EVERY environment, including production and every
   * normal dev machine with the flag left off. Guarding the whole route
   * would make it 404 in exactly those cases, breaking the contract. So the
   * flag check lives HERE instead, deciding only whether the `devToken`
   * field is attached to an otherwise-identical response — the route itself
   * always executes normally. `env.validation.ts` already refuses to boot
   * the app at all unless `NODE_ENV` is exactly `development` or `test`
   * while `DEV_TOOLS_ENABLED=true` — a deliberate allowlist, not merely "not
   * production" (Phase 12, work unit 12D-B2, commit `7cfd411`, replacing the
   * original Phase 10, work unit 10-B5 exact-string denylist check), so by
   * the time this code runs, `devToolsEnabled: true` can only ever be
   * observed in a genuinely non-production environment — no second,
   * redundant `NODE_ENV` check is needed here.
   */
  async requestPasswordReset(
    dto: PasswordResetRequestDto,
    context: AuthRequestContext = {},
  ): Promise<PasswordResetRequestResponseDto> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Generated unconditionally (see doc comment above) so both branches do
    // the same token-generation/hashing work; only persisted below when a
    // real account resolves.
    const rawToken = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashPasswordResetToken(rawToken);

    if (user !== null) {
      // CANONICAL AUTH LOCK ORDER: `User` (rank 1, `FOR SHARE`) before
      // `PasswordResetToken` (rank 2). See this method's doc comment ("THE
      // CREDENTIAL-GENERATION BOUNDARY") for why this INSERT can no longer
      // be a bare auto-commit write, and the canonical block above the class
      // for why `FOR SHARE` is the right mode here.
      const issued = await this.prisma.$transaction(async (tx) => {
        if (!(await this.lockAccountRow(tx, user.id, 'share'))) {
          // A concurrent `deleteAccount()` removed the account between the
          // lookup above and this lock. Falls through to the no-account path
          // below — the same response an unknown email gets — instead of
          // letting the INSERT fail on `PasswordResetToken_userId_fkey`.
          return false;
        }

        await tx.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
          },
        });

        return true;
      });

      if (issued) {
        await this.authAuditService.emit('password_reset_requested', {
          userId: user.id,
          ip: context.ip,
          userAgent: context.userAgent,
        });

        const appConfig = this.configService.get('app', { infer: true })!;

        return appConfig.devToolsEnabled
          ? { success: true, devToken: rawToken }
          : { success: true };
      }
    }

    // No account resolved — either the email is unknown, or a concurrent
    // `deleteAccount()` removed it before the token could be persisted.
    //
    // Fix cycle 1 (review finding 1): a real, unconditional write-shaped
    // round trip against the SAME table the existing-account branch above
    // writes to, so a timing oracle cannot distinguish the two branches by
    // "did a DB write happen" alone. `tokenHash` is derived from bytes
    // generated fresh above, this call only, and never persisted before this
    // point, so this `deleteMany` is mathematically guaranteed to match zero
    // rows — it can never delete a real token, never persists anything, and
    // leaves nothing to clean up or accumulate. See this method's doc
    // comment for the full timing-oracle analysis.
    //
    // Password-reset invalidation slice: wrapped in a transaction taking the
    // same shaped row lock the branch above takes, purely so that branch's
    // new BEGIN/lock/write/COMMIT round-trip profile does not itself become
    // the oracle the `deleteMany` was added to remove. `tokenHash` is passed
    // where a user id goes deliberately: it is a bound parameter (never
    // interpolated), and a 64-character hex digest can never equal a `cuid`
    // `User.id`, so this lock — exactly like the `deleteMany` beside it —
    // provably matches zero rows and blocks nothing.
    await this.prisma.$transaction(async (tx) => {
      await this.lockAccountRow(tx, tokenHash, 'share');
      await tx.passwordResetToken.deleteMany({ where: { tokenHash } });
    });

    await this.authAuditService.emit('password_reset_requested', {
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { reason: 'user_not_found' },
    });

    return { success: true };
  }

  /**
   * Phase 12, work unit 12B-B3: `POST /auth/password-reset/confirm`
   * (DECISIONS.md "Phase 12 ... approved..." entry, decision 3). Consumes a
   * single-use token, sets the new password, and revokes EVERY session for
   * the account — no replacement session is issued, and no "current
   * session" is spared, unlike `changePassword`. This is deliberately MORE
   * aggressive than 12B-B1's `changePassword`: a password reset exists
   * specifically for the scenario where the account may already be
   * compromised (that is the entire reason a reset flow is needed instead
   * of just asking the user to log in and change their password normally),
   * so there is no session worth preserving here, and the caller must log
   * in again afterward with the new password — the same end state
   * `logoutAll` leaves the account in.
   *
   * Race-safety WITHOUT reintroducing 12B-B1's deadlock shape: that incident
   * was a CAS on ONE `Session` row plus a broad revoke of the OTHER
   * `Session` rows, issued as TWO SEPARATE statements with DIFFERENT
   * predicates — two such transactions for the SAME account's two different
   * sessions could lock rows in opposite orders and deadlock (Postgres
   * `40P01`). This method's session-revoke has no such shape: it is a
   * SINGLE, UNCONDITIONED `updateMany` scoped only by `userId` — exactly the
   * same shape `AuthService.logoutAll` already uses and which is
   * deadlock-safe for the identical reason documented there (every
   * concurrent caller's statement converges on the same end state, so there
   * is no cross-wait cycle to form). Unlike `changePassword`, this method
   * never creates a replacement session in the same operation, so there is
   * no "did MY OWN write win a race against ITSELF" question requiring a
   * `RETURNING`-based id-membership check either.
   *
   * Single-use enforcement claims the presented token via a compare-and-swap
   * on the `PasswordResetToken` table, keyed by `usedAt: null` — mirroring
   * `AuthService.revokeSession`'s existing CAS-on-one-row pattern — from the
   * `Session` revoke below (a DIFFERENT table). Two concurrent confirms of
   * the SAME token race only on that one table; a confirm racing a DIFFERENT
   * account's confirm necessarily touches disjoint `Session` rows too.
   * Neither case can form a lock-ordering cycle between the two tables, so
   * this does not reintroduce 12B-B1's bug.
   *
   * Fix cycle 1 (review finding 3 — a new reset does not invalidate other
   * outstanding tokens): closing this required the claim step to also
   * invalidate every OTHER unused, unexpired `PasswordResetToken` for the
   * SAME account (so a still-outstanding earlier token — e.g. one an
   * attacker captured before the legitimate user completes a LATER reset —
   * cannot be used after the account's password has already been reset via
   * a different token). The FIRST attempt at this (a CAS scoped to `id =
   * resetToken.id`, immediately followed by a SEPARATE broad `updateMany`
   * scoped to `userId = ... AND id != resetToken.id`) was rejected before
   * shipping: it is EXACTLY the shape that caused 12B-B1's deadlock — two
   * concurrent confirms for two DIFFERENT outstanding tokens of the SAME
   * account would each lock their own token row first (the CAS), then block
   * trying to lock the OTHER transaction's row (the broad step), forming the
   * identical lock-order cycle `changePassword` had to fix (Postgres
   * `40P01`).
   *
   * The actual fix folds "claim the presented token" and "invalidate every
   * other outstanding token" into the SAME SINGLE statement, reusing
   * `changePassword`'s `RETURNING`-based id-membership CHECK MECHANISM (see
   * that method's doc comment) — but deliberately NOT its rollback-on-loss
   * control flow (see the paragraph below the win/loss check for why that
   * difference is safe here, not an oversight): one `UPDATE ... WHERE
   * "userId" = ... AND "usedAt" IS NULL AND "expiresAt" > now ... RETURNING
   * "id"`, scoped by `userId` (not by the presented token's own `id`),
   * claims EVERY currently-valid token for the account in one pass. Whether
   * THIS request "won" is then a positive, collision-proof check: is the
   * presented token's id (`resetToken.id`, resolved by `tokenHash` before
   * the transaction started) a member of the set of ids this statement just
   * returned? A single statement with one predicate removes the
   * lock-ordering cycle entirely: two concurrent transactions for the same
   * account scan and attempt to lock the identical row set in the same
   * order, so whichever commits first claims everything (including the
   * other's presented token), and the other finds nothing left to claim
   * (its own row already shows `usedAt` set) rather than deadlocking on a
   * row the first transaction is mid-way through broadly updating.
   *
   * Unlike `changePassword`, a LOSS here does not throw a rollback signal —
   * the transaction callback below simply `return`s `false` on a lost claim,
   * which lets `$transaction` COMMIT (see the code below: `if (!wonClaim) {
   * return false; }`). This is a deliberate, verified difference, not an
   * accidental parity break with `changePassword`'s pattern, for two reasons
   * specific to THIS method that do not hold for `changePassword`:
   *   1. The WHERE predicate above is scoped by `userId` ALONE (never by the
   *      presented token's own `id`), so every concurrent confirm for the
   *      SAME account issues the textually IDENTICAL predicate. Whichever
   *      transaction commits first claims the ENTIRE matching row set (every
   *      currently-valid token for that `userId`); every other concurrent
   *      transaction's identical statement then matches zero rows (nothing
   *      left with `usedAt IS NULL`) — a genuine no-op, not a partial or
   *      collateral write that a rollback would need to undo.
   *   2. This transaction creates NO new row (no `issueTokensAndSession`,
   *      unlike `changePassword`'s replacement-session creation), so a
   *      losing transaction has nothing it could have collaterally damaged.
   *      `changePassword` throws specifically because ITS broad,
   *      unconditioned session-revoke predicate can, on the losing side,
   *      match a brand-new row (the winner's freshly created replacement
   *      session) that did not exist when the race began — rollback is what
   *      undoes that collateral revoke. No equivalent new-row hazard exists
   *      here: this method's WHERE clause targets only pre-existing
   *      `PasswordResetToken` rows scoped to one `userId`, a set that cannot
   *      grow mid-race the way `changePassword`'s session set can.
   * Verified empirically: 30 iterations of concurrent confirm(T1) +
   * confirm(T2) requests against the same account produced exactly one
   * winner and zero invariant violations every time; ~280 total concurrent
   * trials across this work unit's testing produced zero Postgres `40P01`
   * deadlocks.
   *
   * The claim-and-invalidate-others statement, the password update, and the
   * `Session` revoke all run inside ONE `prisma.$transaction`, so a mid-way
   * failure cannot leave tokens consumed without the password having
   * actually changed, or vice versa.
   *
   * NOTHING IN THIS METHOD CHANGED in the password-reset invalidation slice
   * — it is recorded here only because that slice completes the symmetry it
   * started. This method already invalidated every outstanding token for the
   * account when a reset succeeded; `changePassword` now does the same when
   * a change succeeds (see its doc comment and the
   * "CREDENTIAL-GENERATION COROLLARY" in the canonical lock-order block), so
   * BOTH password mutations end the previous credential generation, and the
   * two are mutually exclusive per account (both lock `User` first). The
   * observable consequence for this method is on the LOSING side of that
   * race: when a `changePassword` commits first, its invalidation leaves
   * nothing for the claim statement below to claim, so the confirm loses on
   * the existing `wonClaim` check and returns the existing generic
   * `INVALID_PASSWORD_RESET_TOKEN` — no new branch, error code, or event.
   *
   * LOCK ORDERING (Auth lock-order hardening slice — this replaces an
   * earlier, INCOMPLETE analysis that lived here). The earlier reasoning
   * argued no cross-table cycle could form because this transaction never
   * waits on a `Session` lock while holding a `PasswordResetToken` lock:
   * each statement completes before the next begins. That is true and still
   * is — but it only rules out a cycle between two copies of THIS method. It
   * said nothing about the other direction, and that is where the real bug
   * was: this transaction holds `User` (statement 2) and then waits for
   * `Session` (statement 3), while `changePassword` and `deleteAccount` both
   * held `Session` first and then waited for `User`. For a single account
   * that is a genuine Postgres `40P01` cycle, reproduced deterministically
   * against real Postgres 16 for BOTH pairings (see the "lock-order"
   * describe block in `auth.service.spec.ts`). The fix is the `User`-row
   * lock this transaction now takes as its FIRST statement — see the
   * "CANONICAL AUTH LOCK ORDER" block above this class for the full
   * invariant and why locking `User` first is sufficient. The token row is
   * looked up and pre-validated
   * (existence/used/expiry) OUTSIDE the transaction purely to choose a
   * precise audit `reason` for the common case; the transaction's own
   * statement (which re-checks `usedAt IS NULL AND expiresAt > now` at the
   * moment it runs) is the actual source of truth for whether the claim
   * succeeds, not this earlier read.
   */
  async confirmPasswordReset(
    dto: PasswordResetConfirmDto,
    context: AuthRequestContext = {},
  ): Promise<void> {
    const tokenHash = this.hashPasswordResetToken(dto.token);
    const now = new Date();

    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!resetToken) {
      await this.authAuditService.emit('password_reset_confirm_failed', {
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'token_not_found' },
      });
      throw invalidPasswordResetToken();
    }

    if (resetToken.usedAt !== null) {
      await this.authAuditService.emit('password_reset_confirm_failed', {
        userId: resetToken.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'already_used' },
      });
      throw invalidPasswordResetToken();
    }

    if (resetToken.expiresAt <= now) {
      await this.authAuditService.emit('password_reset_confirm_failed', {
        userId: resetToken.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'expired' },
      });
      throw invalidPasswordResetToken();
    }

    const newPasswordHash = await bcrypt.hash(
      dto.newPassword,
      BCRYPT_COST_FACTOR,
    );

    // See this method's doc comment (fix cycle 1, finding 3) for why a
    // SINGLE statement claiming EVERY currently-valid token for this account
    // — not just the one presented — plus a `RETURNING`-based
    // id-membership win/loss check, is what closes "a new reset does not
    // invalidate other outstanding tokens" WITHOUT reintroducing 12B-B1's
    // deadlock shape. Raw SQL (`tx.$queryRaw`, on the `tx` client so it
    // participates in this transaction) is used specifically for the
    // `RETURNING "id"` clause, which Prisma's `updateMany` has no
    // equivalent for. Table/column identifiers verified against
    // `prisma/schema.prisma` (no `@@map`/`@map`).
    //
    // `AT TIME ZONE 'UTC'` on both the read (`"expiresAt"`) and write
    // (`${now}`) sides is REQUIRED, not decorative: `expiresAt`/`usedAt` are
    // `timestamp(3) WITHOUT time zone` columns, and Prisma's own ORM writes
    // UTC wall-clock digits into them (verified empirically). A raw
    // `$queryRaw` parameter, in contrast, binds as `timestamptz`; comparing
    // or assigning it directly against/to a naive column makes Postgres
    // silently reinterpret the naive value using the DATABASE SESSION'S
    // configured `TimeZone` (NOT necessarily UTC — this project's local dev
    // Postgres instance is `Asia/Jakarta`, UTC+7, confirmed via `SHOW
    // TimeZone`), corrupting both the comparison and the stored value by
    // that offset. `AT TIME ZONE 'UTC'` pins the conversion to UTC
    // explicitly, regardless of the session's actual setting, matching what
    // the ORM already does everywhere else in this codebase. (12B-B1's
    // existing `changePassword` raw SQL never compares or assigns a `Date`
    // value this way — it only ever tests `"revokedAt" IS NULL` — so it
    // never hit this; this transaction is the first raw SQL in this file to
    // do a `Date`-valued comparison/assignment, so this fix is scoped
    // entirely to the NEW statement below, not a change to any existing
    // one.)
    const claimed = await this.prisma.$transaction(async (tx) => {
      // CANONICAL AUTH LOCK ORDER, step 1 (see the block above this class):
      // take the account's `User` row lock BEFORE the `PasswordResetToken`
      // claim below. This method already ran `User -> Session` internally,
      // which was the opposite of `changePassword`'s and `deleteAccount`'s
      // `Session -> User` — for one account, that pair of orderings is a
      // genuine Postgres `40P01` cycle (both variants reproduced; see the
      // "lock-order" describe block in `auth.service.spec.ts`). Hoisting the
      // `User` lock to statement one makes this transaction and those two
      // mutually exclusive per account, so neither can hold what the other
      // waits for. `FOR NO KEY UPDATE` is exactly the lock `tx.user.update`
      // below takes anyway.
      //
      // A missing row means a concurrent `deleteAccount()` removed the
      // account. Its `onDelete: Cascade` took every `PasswordResetToken`
      // this account owned with it, so the claim below would have found
      // nothing to claim regardless: falling through to the SAME `return
      // false` the lost-claim branch uses is the truthful outcome, not a
      // special case — the caller gets the same generic
      // `INVALID_PASSWORD_RESET_TOKEN` every other invalid-token rejection
      // returns, with no new enumeration signal.
      if (
        !(await this.lockAccountRow(tx, resetToken.userId, 'no-key-update'))
      ) {
        return false;
      }

      const claimedTokens = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "PasswordResetToken"
        SET "usedAt" = ${now} AT TIME ZONE 'UTC'
        WHERE "userId" = ${resetToken.userId} AND "usedAt" IS NULL AND ("expiresAt" AT TIME ZONE 'UTC') > ${now}
        RETURNING "id"
      `;

      // Positive, collision-proof (session ids — well, token ids here — are
      // unique `cuid`s, not 1ms-resolution `Date` objects) win/loss check:
      // did the token actually PRESENTED in this request come back in the
      // set this statement just claimed? If some other concurrent confirm
      // for this account already consumed it (or it was never valid to
      // begin with — already used/expired at the moment this statement
      // ran), it will not appear here.
      const wonClaim = claimedTokens.some((row) => row.id === resetToken.id);

      if (!wonClaim) {
        return false;
      }

      await tx.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash: newPasswordHash },
      });

      await tx.session.updateMany({
        where: { userId: resetToken.userId, revokedAt: null },
        data: { revokedAt: now },
      });

      return true;
    });

    if (!claimed) {
      // Lost the single-use claim race: another confirm for this exact
      // token (or its expiry, at the boundary) won between the pre-check
      // above and this transaction's own conditional update. Nothing was
      // written by this attempt — treated identically to any other invalid
      // -token rejection.
      await this.authAuditService.emit('password_reset_confirm_failed', {
        userId: resetToken.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'claim_failed' },
      });
      throw invalidPasswordResetToken();
    }

    await this.authAuditService.emit('password_reset_confirmed', {
      userId: resetToken.userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Phase 12, work unit 12C-B1: `POST /users/me/deletion` (DECISIONS.md
   * "Phase 12 ... approved..." entry, decision 1: immediate hard deletion
   * after an explicit irreversible confirmation plus current-password
   * re-authentication; revoke every session and delete the `User` row
   * inside ONE transaction; no grace period; normal-user-only).
   *
   * `dto.confirmDeletion` is validated by `AccountDeletionDto` (`@IsBoolean()`
   * + `@Equals(true)`) at the global `ValidationPipe` BEFORE this method is
   * ever reached — a request missing it, or sending `false`, never gets
   * here at all (a clean `400`, never a silent proceed). This method's own
   * job starts from "the caller genuinely intends this."
   *
   * ORDER OF CHECKS (deliberate, not incidental):
   *   1. Does the access token's `userId` still resolve to a real `User`?
   *      A "no" here is BOTH this endpoint's idempotency story (a second
   *      call after the account was already deleted lands here) AND the
   *      existing, established "authenticated but the user no longer
   *      exists" precedent (`getUserById`/`changePassword` both throw the
   *      SAME `INVALID_ACCESS_TOKEN`/401 for this exact condition) — reused
   *      verbatim rather than inventing a new "already deleted" response
   *      shape, so a repeated call behaves safely and predictably (a
   *      clean, documented 401), never an unhandled 500.
   *   2. Is `dto.currentPassword` correct? Checked BEFORE the role check
   *      below, deliberately: this is an authenticated endpoint (no
   *      email-enumeration concern), but `User.role` is never surfaced by
   *      any other endpoint this app exposes to its own owner (`GET
   *      /auth/me` returns only `id`/`email`/`displayName` — see
   *      `AuthUserDto`), so checking role BEFORE password would let a
   *      caller holding a stolen-but-still-valid access token (without
   *      knowing the password) learn "this account is privileged" for
   *      free. Checking password first means that oracle is only
   *      reachable by someone who ALREADY knows the password — at which
   *      point they already have full control of the account through
   *      every other authenticated route anyway, so nothing new leaks. A
   *      wrong password fails with the SAME generic `INVALID_CREDENTIALS`
   *      `login`/`changePassword` already use.
   *   3. Is `user.role === 'user'`? Any other role is refused with a
   *      DISTINCT, descriptive `403 ACCOUNT_DELETION_FORBIDDEN` (not the
   *      generic `INVALID_CREDENTIALS`) — safe to be specific here per
   *      point 2 above (only reachable with the correct password already
   *      verified), and per decision 1, deleting a privileged account is a
   *      separate, not-yet-built process this phase deliberately does not
   *      create.
   *
   * SESSION REVOCATION + USER DELETION, ONE TRANSACTION: an explicit
   * `session.updateMany({ revokedAt: ... })` runs first (the frozen
   * contract's literal "revoke-all-sessions" step, mirroring `logoutAll`'s
   * identical shape — deadlock-safe for the same reason documented there:
   * every concurrent caller's statement converges on the same end state,
   * so there is no lock-ordering cycle to form), immediately followed by
   * `user.deleteMany` (NOT `user.delete` — see the idempotency paragraph
   * below) in the SAME `prisma.$transaction`. The explicit revoke is
   * technically redundant with what the subsequent delete's cascade already
   * accomplishes (every `Session` row for this account is removed outright,
   * a strictly stronger outcome than "revoked but still present") — it is
   * kept anyway so the "sessions revoked" step is explicit in its own
   * right, matching this codebase's established pattern for every other
   * multi-effect auth mutation (`changePassword`, `confirmPasswordReset`),
   * rather than having this method's behavior depend on cascade
   * configuration alone.
   *
   * `user.deleteMany` (not `user.delete`) makes the delete step itself
   * idempotent/non-throwing under a genuine concurrent-double-submit race:
   * `delete` throws `PrismaClientKnownRequestError` (`P2025`, "record not
   * found") if the row is already gone by the time this statement runs
   * (e.g. two near-simultaneous requests both pass the checks above, then
   * race to delete) — an unhandled error this method's own contract
   * explicitly prohibits. `deleteMany` instead simply matches zero rows and
   * returns `{ count: 0 }`; this method does not need to distinguish "I
   * deleted it" (count 1) from "someone else's concurrent call already
   * had" (count 0) — by the time either caller's transaction returns, the
   * account IS deleted either way, which is the only thing either caller
   * actually asked for. No raw SQL is used anywhere in this method — every
   * statement is Prisma's typed ORM, which (unlike the `$queryRaw` calls
   * elsewhere in this file that touch `timestamp` columns) already writes
   * correct UTC values with no `AT TIME ZONE` handling needed.
   *
   * CASCADES RELIED ON, NOT RE-IMPLEMENTED (verified against
   * `prisma/schema.prisma`/the generated migration SQL): `Session`,
   * `UserVideoInteraction`, `WatchProgress`, `Entitlement`,
   * `PasswordResetToken`, and `AccountLockout` are all `onDelete: Cascade`
   * — every row this account owns in those tables is REMOVED outright by
   * the single `user.deleteMany` below, with no separate cleanup code
   * needed (and none written) here; a deleted-then-re-registered email
   * therefore cannot inherit a stale `AccountLockout` row (it is gone, not
   * merely orphaned). `AnalyticsEvent.userId` and `AuthAuditEvent.userId`
   * are `onDelete: SetNull` — those rows SURVIVE. For `AnalyticsEvent` that
   * is the whole story: the model has no `ipHash`/`userAgent` column at
   * all, so `SetNull` alone (plus the existing `EVENT_PROPERTY_ALLOWLIST`
   * at emission time) already leaves nothing behind that could re-link a
   * surviving row to the deleted account. `AuthAuditEvent` is different and
   * `SetNull` is NOT sufficient for it on its own: that cascade only ever
   * touches the `userId` FK column it is declared on — it does nothing to
   * `ipHash` (Phase 12E, work unit 12E-B1: DECISIONS.md 2026-07-30 decision
   * 1 — an unsalted, unrotated HMAC of the client IP is a globally stable
   * value, so a row that kept it after `userId` went `NULL` would still be
   * correlatable to any other live session/account sharing that same IP,
   * with no brute-forcing required; decision 1 is explicit that calling
   * that "anonymized" would be wrong) or to `userAgent`/`metadata` (neither
   * has any `onDelete` behavior of its own — they are just plain nullable
   * columns). The explicit `tx.authAuditEvent.updateMany(...)` scrub a few
   * lines below this comment — INSIDE this same transaction, and BEFORE
   * `tx.user.deleteMany` — is what actually does that work: it nulls
   * `userId`/`ipHash`/`userAgent`/`metadata` while the row can still be
   * found by `userId`, preserving only `event` and `createdAt` (decision
   * 1's exact instruction). Ordering here is load-bearing, not stylistic:
   * `onDelete: SetNull` fires synchronously, inside this same transaction,
   * the instant `tx.user.deleteMany` runs — so a scrub placed AFTER that
   * call would query `where: { userId }` against rows that already have
   * `userId: null` and silently match zero rows, scrubbing nothing. See the
   * scrub's own inline comment for the rest of this reasoning, and
   * `account-deletion.service.spec.ts` for the regression test that pins
   * this ordering by mutation.
   *
   * `AuthAuditEvent` FOR THE DELETION ITSELF — the exact tension this work
   * unit's own review checklist calls out: an audit row created for THIS
   * deletion, if it referenced `userId`, would have that very reference
   * nulled by the `SetNull` cascade the delete triggers (same as every
   * historical audit row for this account) — so what does "audited" mean
   * once the row it would reference no longer exists? Two shapes were
   * considered: (a) write the audit row INSIDE the same transaction,
   * before the delete, so its insert can validly reference `userId` for an
   * instant before being nulled by the cascade a moment later; or (b) write
   * it AFTER the transaction has already committed, deliberately WITHOUT
   * `userId` at all. (b) is what this method does, for two reasons. First,
   * correctness under failure: `AuthAuditService.emit` is deliberately
   * BEST-EFFORT (it swallows its own errors, per its own doc comment)
   * precisely so an audit-write failure can never break the flow it
   * observes — but that same property makes it the WRONG tool to call for
   * a "did this really happen" row from INSIDE a transaction whose success
   * is exactly what's in question: emitting before/during the transaction
   * risks recording "success" for a deletion that then fails to commit.
   * The success event below is therefore emitted ONLY after `$transaction`
   * has returned without throwing, so it is never written for a deletion
   * that did not actually happen — matching this class's OWN established
   * "emit right after the state-changing write that already durably
   * happened, not inside a still-uncertain operation" precedent
   * (`register`/`login` already emit `register_success`/`login_success`
   * this same way, non-transactionally, right after their own
   * `user.create`/lookup). Second, attempting to CREATE a brand-new
   * `AuthAuditEvent` row that references `userId` for a user that no
   * longer exists (i.e. emitting AFTER commit, WITH the id) would violate
   * the very foreign key this schema relies on — inserting a non-null FK
   * value that matches no existing row is rejected at the database level
   * regardless of `onDelete: SetNull` (that action only fires when the
   * REFERENCED row is deleted, never on an INSERT of a dangling reference)
   * — so recording `userId` post-commit is not merely stylistically wrong,
   * it would concretely fail. Omitting `userId` entirely for
   * `account_deletion_success` (never passing it, so it stores `null` —
   * see `EmitAuthAuditEventParams`'s existing "omit entirely, don't pass a
   * stale value" convention) sidesteps both problems while still leaving a
   * genuinely useful audit trail: an operator can query `AuthAuditEvent`
   * for `event = 'account_deletion_success'` and get an accurate,
   * timestamped COUNT of real account deletions — this table's whole
   * purpose for a deleted account, per its own schema doc comment ("survive
   * the attacker later deleting the compromised account") — without
   * retaining any link back to WHICH account, which decision 2 requires
   * anyway. This exactly mirrors `login_failed`'s existing "unresolved
   * email → no `userId`, nothing to link to" case, just for the opposite
   * direction (no longer anything TO link to, rather than not yet). The
   * two FAILURE events below (`account_deletion_failed`) are the OPPOSITE
   * case: the account is NOT being deleted (the request was refused), so it
   * still exists, `userId` is included exactly like `change_password_failed`
   * already does, and there is no FK/`SetNull` tension to resolve.
   *
   * IDOR-safety: this method only ever acts on the `userId` resolved from
   * the caller's OWN verified access token (`JwtAuthGuard` /
   * `@CurrentUser()`) — there is no id-shaped input anywhere in
   * `AccountDeletionDto`, so there is no client-supplied identifier for a
   * cross-account attempt to even target.
   */
  async deleteAccount(
    userId: string,
    dto: AccountDeletionDto,
    context: AuthRequestContext = {},
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new AppException(
        AppErrorCode.INVALID_ACCESS_TOKEN,
        'Invalid or expired access token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );

    if (!passwordMatches) {
      await this.authAuditService.emit('account_deletion_failed', {
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'invalid_current_password' },
      });
      throw invalidCredentials();
    }

    if (user.role !== 'user') {
      await this.authAuditService.emit('account_deletion_failed', {
        userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'role_not_allowed' },
      });
      throw new AppException(
        AppErrorCode.ACCOUNT_DELETION_FORBIDDEN,
        'Self-service account deletion is not available for this account type',
        HttpStatus.FORBIDDEN,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // CANONICAL AUTH LOCK ORDER, step 1 (see the block above this class):
      // take the account's `User` row lock BEFORE the session revoke below.
      // This transaction used to run `Session -> ... -> User`, the exact
      // inversion of `confirmPasswordReset`'s `User -> ... -> Session`, and
      // the resulting `40P01` cycle was reproduced against real Postgres
      // (see the "lock-order" describe block in `auth.service.spec.ts`).
      // `FOR UPDATE` (not `FOR NO KEY UPDATE`) matches what this
      // transaction's own closing `DELETE` needs — a key-affecting lock —
      // so the row is locked once, in the right mode, at the right time.
      //
      // The return value is deliberately not branched on: a missing row
      // means a concurrent `deleteAccount()` already removed this account,
      // and every statement below is already a no-op-safe `updateMany` /
      // `deleteMany` for that case. That is this method's documented
      // idempotency contract ("by the time either caller's transaction
      // returns, the account IS deleted either way"), unchanged.
      await this.lockAccountRow(tx, userId, 'update');

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      // Phase 12, work unit 12E-B1 (DECISIONS.md 2026-07-30, decision 1):
      // scrub this account's OWN `AuthAuditEvent` rows BEFORE `tx.user.deleteMany`
      // below — see this method's own doc comment ("CASCADES RELIED ON")
      // for the full ordering rationale. In short: `AuthAuditEvent.userId`
      // is `onDelete: SetNull`, and Postgres fires that cascade
      // synchronously, inside this SAME transaction, the instant the user
      // row is deleted — so a scrub placed after the delete would query
      // `where: { userId }` against rows whose `userId` is already `null`
      // and silently match nothing. Running it here, first, means this
      // `updateMany` still finds every row this account owns.
      //
      // `userId` is nulled explicitly (redundant with the cascade that is
      // about to fire anyway — kept for clarity, matching this method's
      // existing "explicit even when cascade-redundant" precedent for
      // session revocation above) alongside `ipHash` and `userAgent`,
      // NEITHER of which the cascade ever touches (it only affects the FK
      // column it is declared on): `ipHash` is an unsalted, unrotated HMAC
      // of the client IP — a globally stable value — so leaving it behind
      // would keep the row correlatable to any other live session/account
      // sharing that IP with no brute-forcing required, which is exactly
      // the overstated "anonymized" claim decision 1 forbids describing.
      // `event` and `createdAt` are the only columns left untouched,
      // matching decision 1's "preserve only the allowlisted event type and
      // the timestamp" instruction exactly.
      //
      // `metadata` is nulled WHOLESALE (`Prisma.DbNull` — true SQL `NULL`;
      // NOT `Prisma.JsonNull`, which would instead persist the JSON scalar
      // `null` and leave the column non-NULL) rather than stripped
      // key-by-key against `AUTH_AUDIT_METADATA_ALLOWLIST`. Every allowlisted
      // value today is already a small, non-identifying enum string (see
      // `auth-audit.types.ts`) — selective stripping would preserve
      // negligible operational value over nulling outright, while adding a
      // second place that has to be kept in sync with that allowlist
      // forever, and a second way to get it wrong. Wholesale nulling cannot
      // leak regardless of what a future event/metadata key adds.
      await tx.authAuditEvent.updateMany({
        where: { userId },
        data: {
          userId: null,
          ipHash: null,
          userAgent: null,
          metadata: Prisma.DbNull,
        },
      });

      await tx.user.deleteMany({ where: { id: userId } });
    });

    await this.authAuditService.emit('account_deletion_success', {
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Refresh tokens are hashed with HMAC-SHA256 keyed by `JWT_REFRESH_SECRET`
   * (not plain SHA-256, and not bcrypt) before being persisted:
   * - Plain SHA-256 would be fine against brute force alone, since the
   *   refresh token is already 256 bits of random entropy (unlike a
   *   user-chosen password, there is no low-entropy guessing risk bcrypt's
   *   deliberate slowness defends against).
   * - Keying it (HMAC) with a server-side secret means a leak of the
   *   `Session` table alone (e.g. a DB dump) is not sufficient to forge a
   *   value that matches `refreshTokenHash` for a chosen token, and rotating
   *   `JWT_REFRESH_SECRET` invalidates all outstanding sessions at once if
   *   ever needed as an incident-response measure.
   * - A fast hash (vs. bcrypt) is deliberately used because refresh-token
   *   lookups happen on every refresh call and do not need bcrypt's
   *   deliberate slowness; that slowness exists specifically to defend
   *   against offline guessing of low-entropy secrets, which does not apply
   *   here.
   */
  private hashRefreshToken(token: string): string {
    const authConfig = this.configService.get('auth', { infer: true })!;
    return createHmac('sha256', authConfig.jwtRefreshSecret)
      .update(token)
      .digest('hex');
  }

  /**
   * Phase 12, work unit 12B-B3: hashes a password-reset token the exact same
   * way `hashRefreshToken` above hashes a refresh token — HMAC-SHA256, keyed
   * with a server-side secret, never bcrypt (both values are already 256
   * bits of random entropy; there is no low-entropy-guessing risk for
   * bcrypt's deliberate slowness to defend against, and both refresh-token
   * and reset-token lookups need to stay fast, not deliberately slow).
   *
   * Deliberately REUSES `jwtRefreshSecret` — the SAME secret
   * `hashRefreshToken` uses — rather than minting a fourth auth-related
   * secret (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and
   * `AUTH_AUDIT_IP_HASH_SECRET` already exist). This is a deliberate,
   * reasoned choice, not a silent reuse-by-default:
   *   - A password-reset token and a refresh token are cryptographically the
   *     SAME kind of value: an opaque, high-entropy bearer secret whose only
   *     server-side check is "does its keyed hash match a stored row" —
   *     neither is ever verified via a slow, low-entropy-oriented comparison
   *     (bcrypt) the way a password is. `AUTH_AUDIT_IP_HASH_SECRET` hashes a
   *     fundamentally DIFFERENT kind of value (a client IP — semi
   *     -identifying operational metadata, not a bearer credential) for a
   *     fundamentally different purpose (correlation/audit, not credential
   *     verification), so it is the wrong bucket to reuse here even though
   *     it is also "dedicated" — DECISIONS.md decision 6's requirement that
   *     IT be distinct from the JWT/refresh signing secrets was scoped to
   *     ITS OWN purpose (hashing operational metadata), not a blanket rule
   *     that every future keyed hash in this codebase needs its own brand
   *     new secret.
   *   - Rotating `JWT_REFRESH_SECRET` (e.g. as an incident-response measure
   *     after a suspected credential leak) already invalidates every
   *     outstanding refresh token; having it ALSO invalidate every
   *     outstanding password-reset token under the same rotation is the
   *     desired behavior, not an unwanted side effect — if this secret's
   *     exposure is suspected, every bearer-token-shaped value it protects
   *     should be cut off at once, not just half of them.
   *   - Avoids adding a fourth long-lived auth secret to `.env`/deployment
   *     config, with its own generation/rotation/storage story, for zero
   *     additional security benefit over reusing this one, given the
   *     identical threat model above (KISS).
   *
   * Fix cycle 1 (review finding 2 — missing HMAC domain separation): reusing
   * the SAME secret as `hashRefreshToken` (reasoned above) is fine, but
   * reusing the secret with an IDENTICAL, untagged HMAC input (as this
   * method originally did) meant a reset-token hash and a refresh-token
   * hash were textually indistinguishable functions of the same key —
   * nothing today exploits that (lookups hit disjoint, `@unique`-indexed
   * tables, and both values are independent `randomBytes(32)`), but it is a
   * latent hygiene defect a future refactor could trip over, e.g. someone
   * writing a single "look up any bearer token by hash across tables"
   * helper. `PASSWORD_RESET_TOKEN_HASH_DOMAIN` (`auth.constants.ts`) is
   * mixed into the HMAC input ON THIS METHOD ONLY, as a fixed prefix ending
   * in a delimiter the token's own hex-only alphabet can never contain —
   * so a reset-token hash can never collide with, or be reinterpreted as, a
   * refresh-token hash even though both share a key. `hashRefreshToken`
   * above is DELIBERATELY left completely unmodified: because there are no
   * outstanding reset tokens in any database yet (this endpoint has never
   * shipped), changing THIS function's output is safe, but changing
   * `hashRefreshToken`'s would invalidate every `Session.refreshTokenHash`
   * for every already-logged-in user everywhere — domain separation only
   * needs one side of the pair to differ, so only this side changes.
   */
  private hashPasswordResetToken(token: string): string {
    const authConfig = this.configService.get('auth', { infer: true })!;
    return createHmac('sha256', authConfig.jwtRefreshSecret)
      .update(PASSWORD_RESET_TOKEN_HASH_DOMAIN)
      .update(token)
      .digest('hex');
  }
}
