import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { RootConfig } from '../../../config/configuration';
import { redactSensitiveText } from '../../../common/logging/redact';
import { PrismaService } from '../../../prisma/prisma.service';
import { hashIp } from '../../auth-crypto';
import { AuthRequestContext } from '../../auth.types';
import {
  OTP_CHALLENGE_RETENTION_MS,
  OTP_CODE_DIGITS,
  OTP_CODE_HASH_DOMAIN,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_WINDOW,
  OTP_PRUNE_BATCH_LIMIT,
  OTP_REQUEST_WINDOW_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from '../auth-identity.constants';
import { classifyUniqueViolation } from '../unique-violation';
import { LocalFakeWhatsAppOtpProvider } from './whatsapp-local-fake.provider';
import { WHATSAPP_OTP_PROVIDER } from './whatsapp-otp.types';
// `import type` is REQUIRED for an interface referenced in a decorated
// constructor signature under `isolatedModules` + `emitDecoratorMetadata`
// (TS1272) — see `auth-identity.service.ts` for the same note.
import type { WhatsAppOtpProvider } from './whatsapp-otp.types';

/**
 * PHASE 10B — the WhatsApp OTP CHALLENGE LIFECYCLE, and nothing else.
 *
 * Deliberately a separate service from `AuthIdentityService`: issuing,
 * rate-limiting, expiring, counting attempts against and atomically
 * consuming a one-time code is a self-contained concern with its own table
 * and its own concurrency story, and mixing it into the identity-resolution
 * service produced one file well past this project's size guideline
 * (`common/coding-style.md`: many small, cohesive files). This service knows
 * nothing about `User`, `AuthIdentity` or sessions; `AuthIdentityService`
 * knows nothing about attempt budgets or cooldowns.
 *
 * ==================== CONCURRENCY / LOCK-ORDER CONTRACT ====================
 *
 * EVERY write in this file is a SINGLE-STATEMENT, auto-commit statement.
 * Nothing here ever runs inside a multi-statement `prisma.$transaction`, and
 * that is load-bearing rather than incidental — see the "CANONICAL AUTH LOCK
 * ORDER" block in `src/auth/auth.service.ts`. A single-statement transaction
 * can block and can be blocked, but it can never hold a lock on one table
 * while waiting on another, so `PhoneOtpChallenge` cannot supply an edge to
 * a deadlock cycle even though it is written immediately before the
 * account-scoped transaction that issues a session.
 *
 * The attempt budget and the single-use claim are both enforced by
 * predicates in a `WHERE` clause (`attemptCount < N`, `consumedAt IS NULL`),
 * never by a read-then-write in application code. That is what makes them
 * hold under concurrency — the same CAS-on-one-row idiom
 * `AuthService.refresh`'s rotation and `confirmPasswordReset`'s claim
 * already use.
 */

/**
 * Internal, non-client-facing reason an OTP was refused. Surfaces in the
 * audit trail as `identity_login_failed`'s `reason`; the CALLER always
 * receives the identical generic `INVALID_OTP` (see that error code for why
 * splitting it would create a phone-number enumeration oracle).
 */
export type OtpRejectionReason =
  | 'otp_not_found'
  | 'otp_expired'
  | 'otp_wrong_code'
  | 'otp_attempts_exhausted'
  | 'otp_claim_lost';

/** Thrown so the caller can audit `reason` while answering generically. */
export class OtpRejected extends Error {
  constructor(readonly reason: OtpRejectionReason) {
    super(`otp rejected: ${reason}`);
  }
}

/** Why a request for a new code was refused by the per-NUMBER limits. */
export type OtpThrottleReason = 'cooldown' | 'window_exhausted';

/** Thrown so the caller can audit `reason` and map it to `OTP_RESEND_COOLDOWN`. */
export class OtpRequestThrottled extends Error {
  constructor(readonly reason: OtpThrottleReason) {
    super(`otp request throttled: ${reason}`);
  }
}

export interface IssuedOtpChallenge {
  expiresInSeconds: number;
  /**
   * The plaintext code, present ONLY when dev-token exposure is permitted
   * (see `exposeDevCode`). `undefined` in every other case, including every
   * production configuration.
   */
  devCode?: string;
}

@Injectable()
export class WhatsAppOtpService {
  private readonly logger = new Logger(WhatsAppOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    @Inject(WHATSAPP_OTP_PROVIDER)
    private readonly provider: WhatsAppOtpProvider,
  ) {}

  /**
   * Issues a fresh challenge for `phoneE164` and hands the code to the
   * configured delivery provider.
   *
   * ORDER OF OPERATIONS, and why it is this order:
   *   1. an opportunistic, BOUNDED prune of long-dead challenge rows, so a
   *      phone number belonging to someone who may not even have an account
   *      here does not linger indefinitely (this table has no owning `User`
   *      to cascade from and no janitor job to schedule);
   *   2. a cheap pre-check of the cooldown and rolling budget, which rejects
   *      the ordinary repeat-tap without writing anything;
   *   3. retire this number's outstanding challenge (if any), releasing its
   *      `liveKey` slot, then INSERT the new one INTO that slot. The unique
   *      index on `liveKey` is what makes "at most one live challenge per
   *      number" atomic — a concurrent request that claimed the slot first
   *      makes this INSERT lose, and the loser is answered `cooldown`. This
   *      replaced an earlier "INSERT, then re-read and decide who won"
   *      reconciliation that two concurrent callers could BOTH win, leaving
   *      a number with no usable code at all (see the `liveKey` doc comment
   *      in `prisma/schema.prisma`);
   *   4. delivery, whose failure is logged and swallowed — the caller's
   *      response must be identical whether or not the vendor was
   *      reachable, and a vendor outage is an operator problem rather than
   *      a signal to hand an unauthenticated caller.
   */
  async issueChallenge(
    phoneE164: string,
    context: AuthRequestContext,
  ): Promise<IssuedOtpChallenge> {
    const now = new Date();

    await this.pruneStaleChallenges(now);
    await this.assertRequestAllowed(phoneE164, now);

    await this.retireSlotIfNoLongerEntitled(phoneE164, now);

    const code = generateOtpCode();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    const authConfig = this.configService.get('auth', { infer: true })!;

    try {
      await this.prisma.phoneOtpChallenge.create({
        data: {
          phoneE164,
          // Claims the number's single live slot. A concurrent request that
          // already claimed it makes this INSERT lose the unique index.
          liveKey: phoneE164,
          codeHash: this.hashOtpCode(phoneE164, code),
          expiresAt,
          ipHash:
            context.ip !== undefined
              ? hashIp(context.ip, authConfig.authAuditIpHashSecret)
              : null,
        },
        select: { id: true },
      });
    } catch (error) {
      if (classifyUniqueViolation(error) === 'otp_live_challenge') {
        // Another request for this same number claimed the live slot between
        // this one's cooldown pre-check and this INSERT. That is exactly what
        // the cooldown is for, and the database — not a re-read — decided it.
        throw new OtpRequestThrottled('cooldown');
      }
      throw error;
    }

    await this.deliver(phoneE164, code, expiresAt, now);

    return {
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      devCode: this.exposeDevCode(code),
    };
  }

  /**
   * Releases this number's live slot, but ONLY if the challenge holding it
   * has outlived its cooldown — never unconditionally.
   *
   * THE PREDICATE IS LOAD-BEARING, and getting it wrong costs real messages.
   * An unconditional "retire whatever is live, then insert" would let a
   * SECOND request in a simultaneous burst retire the FIRST one's
   * freshly-claimed slot and then claim it itself: both requests succeed,
   * both send a message to the same person, and only the later code works.
   * Restricting the retirement to challenges older than the cooldown window
   * makes a burst behave exactly like the sequential case — the first
   * request claims the slot, every other loses the unique index and is
   * answered `cooldown`, and exactly ONE message is sent.
   *
   * An EXPIRED-but-unconsumed challenge is covered by the same predicate
   * rather than needing its own: `OTP_TTL_MS` (5 minutes) is deliberately
   * longer than `OTP_RESEND_COOLDOWN_MS` (60 seconds), so anything expired
   * is necessarily past the cooldown too. Adding a separate "or expired"
   * clause would be redundant today and, if the TTL were ever shortened
   * below the cooldown, would quietly become a way to bypass the cooldown —
   * so it is deliberately absent, and this comment is why.
   *
   * `consumedAt` and `liveKey` are written TOGETHER, in one statement,
   * always. The invariant "holding the slot means unconsumed" is true only
   * because every consume path in this file does both at once.
   */
  private async retireSlotIfNoLongerEntitled(
    phoneE164: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.phoneOtpChallenge.updateMany({
      where: {
        phoneE164,
        consumedAt: null,
        createdAt: { lt: new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS) },
      },
      data: { consumedAt: now, liveKey: null },
    });
  }

  /**
   * Verifies and atomically CONSUMES the outstanding challenge for
   * `phoneE164`. Resolves only when the caller has genuinely proved control
   * of the number; throws `OtpRejected` otherwise.
   *
   * Three steps, and the ordering of the first two is deliberate:
   *
   *   1. RESERVE AN ATTEMPT — a conditional `UPDATE ... WHERE attemptCount <
   *      N AND consumedAt IS NULL AND expiresAt > now`. The budget is
   *      enforced BY THE DATABASE, so firing guesses concurrently cannot
   *      exceed it. A check-in-JS-then-update would let N parallel requests
   *      all read the same count and all proceed — and that budget is the
   *      entire defense for a 6-digit secret.
   *   2. COMPARE, in constant time, against the stored keyed hash. This runs
   *      AFTER the attempt is durably recorded so that a wrong guess costs
   *      an attempt even if the process dies mid-request; the other order
   *      would let a crash-looping attacker guess for free.
   *   3. CLAIM, conditioned on `consumedAt IS NULL`. Two concurrent verifies
   *      of the same CORRECT code both reach this statement; exactly one
   *      matches a row and the loser is refused, which is what makes a code
   *      genuinely single-use rather than single-use-when-nobody-is-racing.
   */
  async claimChallenge(phoneE164: string, code: string): Promise<void> {
    const now = new Date();

    // At most one row can match: `PhoneOtpChallenge.liveKey`'s unique index
    // guarantees one live challenge per number. `orderBy` is kept as
    // belt-and-braces so this stays deterministic even if that invariant
    // were ever relaxed — it must never become "whichever row the planner
    // returned first".
    const challenge = await this.prisma.phoneOtpChallenge.findFirst({
      where: { phoneE164, consumedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!challenge) {
      // Covers "never requested a code", "already used it", and "a newer
      // request superseded it" alike — all indistinguishable to the caller.
      throw new OtpRejected('otp_not_found');
    }
    if (challenge.expiresAt <= now) {
      throw new OtpRejected('otp_expired');
    }
    if (challenge.attemptCount >= OTP_MAX_ATTEMPTS) {
      throw new OtpRejected('otp_attempts_exhausted');
    }

    const { count: reserved } = await this.prisma.phoneOtpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        expiresAt: { gt: now },
        attemptCount: { lt: OTP_MAX_ATTEMPTS },
      },
      data: { attemptCount: { increment: 1 } },
    });

    if (reserved === 0) {
      // Lost to a concurrent verify that consumed the challenge, exhausted
      // the budget, or crossed the expiry between the read above and this
      // write. Every one of them is the same refusal to the caller.
      throw new OtpRejected('otp_attempts_exhausted');
    }

    if (
      !constantTimeHexEquals(
        challenge.codeHash,
        this.hashOtpCode(phoneE164, code),
      )
    ) {
      throw new OtpRejected('otp_wrong_code');
    }

    const { count: claimed } = await this.prisma.phoneOtpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      // `liveKey` is released in the SAME statement that marks the challenge
      // consumed — never a follow-up write — so the number's live slot can
      // never be held by an already-consumed row.
      data: { consumedAt: now, liveKey: null },
    });

    if (claimed === 0) {
      throw new OtpRejected('otp_claim_lost');
    }
  }

  /**
   * The `LocalFakeWhatsAppOtpProvider` instance, when that is what is bound
   * — so an e2e suite can read back the code that "was sent" without
   * reaching into the database, exercising the same "the user read the
   * message" step a real client performs. Returns `undefined` for every
   * other provider, so no production configuration can expose a code
   * through it.
   */
  get localFakeProvider(): LocalFakeWhatsAppOtpProvider | undefined {
    return this.provider instanceof LocalFakeWhatsAppOtpProvider
      ? this.provider
      : undefined;
  }

  /**
   * Enforces the per-NUMBER cooldown and rolling request budget — the limits
   * that actually protect a victim's phone from being bombed with messages,
   * as opposed to the per-IP `@Throttle()` on the route, which an attacker
   * defeats simply by rotating source IPs.
   *
   * A CHEAP PRE-CHECK, deliberately not the only enforcement: it rejects the
   * ordinary repeat-tap without writing a row, while the check-then-act race
   * two simultaneous requests could otherwise win is closed by the unique
   * index on `PhoneOtpChallenge.liveKey` — see `issueChallenge`.
   */
  private async assertRequestAllowed(
    phoneE164: string,
    now: Date,
  ): Promise<void> {
    const cooldownStart = new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS);

    const recent = await this.prisma.phoneOtpChallenge.findFirst({
      where: { phoneE164, createdAt: { gte: cooldownStart } },
      select: { id: true },
    });

    if (recent) {
      throw new OtpRequestThrottled('cooldown');
    }

    const windowStart = new Date(now.getTime() - OTP_REQUEST_WINDOW_MS);
    const windowCount = await this.prisma.phoneOtpChallenge.count({
      where: { phoneE164, createdAt: { gte: windowStart } },
    });

    if (windowCount >= OTP_MAX_REQUESTS_PER_WINDOW) {
      throw new OtpRequestThrottled('window_exhausted');
    }
  }

  /**
   * Bounded, opportunistic retention cleanup — see
   * `OTP_CHALLENGE_RETENTION_MS` / `OTP_PRUNE_BATCH_LIMIT`. Failure is
   * logged and swallowed: a cleanup problem must never turn a legitimate
   * sign-in request into an error.
   */
  private async pruneStaleChallenges(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - OTP_CHALLENGE_RETENTION_MS);

    try {
      const stale = await this.prisma.phoneOtpChallenge.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: OTP_PRUNE_BATCH_LIMIT,
      });

      if (stale.length > 0) {
        await this.prisma.phoneOtpChallenge.deleteMany({
          where: { id: { in: stale.map((row) => row.id) } },
        });
      }
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Opportunistic PhoneOtpChallenge prune failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  private async deliver(
    phoneE164: string,
    code: string,
    expiresAt: Date,
    now: Date,
  ): Promise<void> {
    try {
      await this.provider.sendOtp({
        phoneE164,
        code,
        expiresInSeconds: Math.max(
          Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
          0,
        ),
      });
    } catch (error) {
      // Never the code, and never the full number — this line is the one
      // thing about OTP delivery that plausibly ends up in a shared log.
      this.logger.error(
        redactSensitiveText(
          `WhatsApp OTP delivery failed for ...${phoneE164.slice(-4)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * HMAC-SHA256 over a fixed domain tag PLUS THE PHONE NUMBER, keyed with
   * `JWT_REFRESH_SECRET` — the same key `AuthService.hashRefreshToken` and
   * `.hashPasswordResetToken` use, for the reasons documented at length on
   * the latter (all three protect opaque bearer values; rotating the key
   * should cut all of them off together; a fourth long-lived auth secret
   * would add real operational cost for no security gain).
   *
   * THE PHONE BINDING IS NOT DECORATION. Unlike those two 256-bit tokens, an
   * OTP has only 10^6 possible values: without binding, ONE precomputed
   * table of `HMAC(secret, code)` would cover every code this system ever
   * issues, and anyone who saw a stored hash could recognize the same code
   * on a different number. Mixing the number in gives every challenge its
   * own hash space. The `':'` separator prevents the concatenation
   * ambiguity that would otherwise let a different (number, code) split
   * produce the same input bytes.
   *
   * Deliberately NOT bcrypt: the defense for a low-entropy code is the
   * attempt limit plus the short expiry, not hash slowness — and a
   * deliberately slow hash on an unauthenticated verify endpoint is a
   * CPU-exhaustion lever, not a safeguard.
   */
  private hashOtpCode(phoneE164: string, code: string): string {
    const authConfig = this.configService.get('auth', { infer: true })!;
    return createHmac('sha256', authConfig.jwtRefreshSecret)
      .update(OTP_CODE_HASH_DOMAIN)
      .update(phoneE164)
      .update(':')
      .update(code)
      .digest('hex');
  }

  /**
   * The plaintext code, but ONLY when `DEV_TOOLS_ENABLED=true` AND
   * `NODE_ENV` is exactly `development` or `test` — the identical gate
   * `AuthService.requestPasswordReset` applies to its `devToken`,
   * deliberately reused rather than reinvented so there is exactly ONE
   * implementation of "may a secret appear in a response body" to review.
   *
   * This is the fourth independent gate on the fake provider (see
   * `LocalFakeWhatsAppOtpProvider`'s doc comment): even if the other three
   * were somehow bypassed, no code reaches a response without this one.
   */
  private exposeDevCode(code: string): string | undefined {
    const appConfig = this.configService.get('app', { infer: true })!;
    const nodeEnv = process.env.NODE_ENV;

    return appConfig.devToolsEnabled &&
      (nodeEnv === 'development' || nodeEnv === 'test')
      ? code
      : undefined;
  }
}

/**
 * Six cryptographically random decimal digits, zero-padded. `randomInt` is
 * Node's CSPRNG-backed, rejection-sampled uniform integer generator — NEVER
 * `Math.random()` (not cryptographically secure) and never
 * `randomBytes(n) % 10` per digit (modulo-biased, so some digits would be
 * likelier than others). Zero-padding keeps every code exactly
 * `OTP_CODE_DIGITS` long, so "000123" is an ordinary code rather than a
 * shorter, weaker one.
 */
function generateOtpCode(): string {
  const upperBound = 10 ** OTP_CODE_DIGITS;
  return randomInt(0, upperBound).toString().padStart(OTP_CODE_DIGITS, '0');
}

/**
 * Constant-time comparison of two hex digests. Both are fixed-length
 * SHA-256 outputs, so the length guard can only trip on a corrupted row —
 * but comparing with `===` would still leak, through timing, how many
 * leading characters of a candidate hash matched. `timingSafeEqual` throws
 * on unequal lengths, hence the guard rather than a bare call.
 */
function constantTimeHexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
