import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes } from 'crypto';
import type { Prisma, User } from '@prisma/client';
import { RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import {
  ACCESS_TOKEN_TTL,
  BCRYPT_COST_FACTOR,
  DUMMY_HASH_FOR_TIMING_PARITY,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_MS,
} from './auth.constants';
import { AuthRequestContext, AuthResponseDto, AuthUserDto } from './auth.types';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<RootConfig>,
    private readonly accountLockoutService: AccountLockoutService,
    private readonly authAuditService: AuthAuditService,
  ) {}

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

    return this.issueTokensAndSession(user);
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

    await this.accountLockoutService.recordSuccess(user.id);
    await this.authAuditService.emit('login_success', {
      userId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return this.issueTokensAndSession(user);
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
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
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

    return this.issueTokensAndSession(user);
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

  private async issueTokensAndSession(
    user: Pick<User, 'id' | 'email' | 'displayName'>,
    client: PrismaClientLike = this.prisma,
  ): Promise<AuthResponseDto> {
    const authConfig = this.configService.get('auth', { infer: true })!;

    // Access token payload intentionally carries only the user id (`sub`) —
    // never the password hash or any other sensitive field.
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id },
      { secret: authConfig.jwtAccessSecret, expiresIn: ACCESS_TOKEN_TTL },
    );

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const refreshTokenHash = this.hashRefreshToken(refreshToken);

    await client.session.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
      select: { id: true },
    });

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

    let rotation: ChangePasswordRotationResult;
    try {
      rotation = await this.prisma.$transaction(async (tx) => {
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
        const revokedSessions = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "Session"
          SET "revokedAt" = ${now}
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
        // create.
        const response = await this.issueTokensAndSession(user, tx);

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
        // session just created above (by its `refreshTokenHash`, computed
        // locally — no extra round trip needed to look its id up). It is
        // NOT a second win/loss check (that was already decided above); it
        // is purely additive cleanup, so its `count` is intentionally
        // ignored.
        const newSessionHash = this.hashRefreshToken(response.refreshToken);
        await tx.session.updateMany({
          where: {
            userId,
            revokedAt: null,
            refreshTokenHash: { not: newSessionHash },
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
}
