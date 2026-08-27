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
  OTP_PURPOSE_HASH_DOMAINS,
  OTP_REQUEST_WINDOW_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from '../auth-identity.constants';
import type { OtpPurpose } from '../auth-identity.constants';
import { classifyUniqueViolation } from '../unique-violation';
import { LocalFakeWhatsAppOtpProvider } from './whatsapp-local-fake.provider';
import {
  WHATSAPP_OTP_PROVIDER,
  WhatsAppDeliveryError,
} from './whatsapp-otp.types';
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

/**
 * WHATSAPP LOGIN V1 — delivery DEFINITIVELY failed for a reason that has
 * nothing to do with which number was targeted (see
 * `WhatsAppDeliveryFailureKind`). The challenge has already been withdrawn
 * by the time this is thrown, so the caller may safely tell the user to try
 * again — there is no live code, and nothing was charged against the
 * number's cooldown or rolling budget.
 *
 * Kept as its own signal class rather than an `AppException` for the same
 * reason as `OtpRejected`/`OtpRequestThrottled`: this service does not own
 * the HTTP contract. `AuthIdentityService` decides what a client sees.
 */
export class OtpDeliveryFailed extends Error {
  constructor(readonly httpStatus?: number) {
    super('otp delivery failed: provider unavailable');
  }
}

export interface IssuedOtpChallenge {
  expiresInSeconds: number;
  /**
   * PHASE 10C: the per-number resend COOLDOWN — a MINIMUM wait, never a
   * promise that the next request will be accepted.
   *
   * Always the full `OTP_RESEND_COOLDOWN_MS`, because a challenge that was
   * just issued restarts the cooldown by definition — this is never a
   * remaining-time computation against an EXISTING challenge, so it cannot
   * vary by caller or by number and therefore carries no account-existence
   * or recent-activity signal. Exactly the same "fixed, public constant of
   * the system" property that already makes `expiresInSeconds` safe.
   *
   * IT IS THE COOLDOWN ONLY, and two other limiters sit beside it, so a
   * finished countdown is not permission:
   *   - the per-IP `@Throttle()` on the route (3 per 10 min) — the one an
   *     ordinary user actually reaches, since one send plus two resends
   *     exhausts it. Its `429` comes from the framework, so it carries
   *     `code: "HTTP_ERROR"`, NOT `OTP_RESEND_COOLDOWN`.
   *   - the per-number rolling budget (`OTP_MAX_REQUESTS_PER_WINDOW` in
   *     `OTP_REQUEST_WINDOW_MS`), whose refusal can be nearly an hour away
   *     even though this field said 60.
   * A client MUST keep handling `429` on resend rather than treating a
   * finished countdown as a guarantee.
   *
   * Deliberately NOT computed from the number's real request history: that
   * would vary by how recently somebody asked for a code for this number,
   * which is exactly the recent-activity oracle the `202` contract avoids.
   *
   * It exists so a client renders its resend countdown from the server's
   * own value instead of hardcoding one that would silently drift from
   * `OTP_RESEND_COOLDOWN_MS`.
   */
  resendAvailableInSeconds: number;
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
   *   4. delivery. A failure here is NO LONGER uniformly swallowed — see
   *      `deliverOrWithdraw`. A number-INDEPENDENT provider outage withdraws
   *      the challenge just created and propagates, because answering `202`
   *      to a user who will never receive a message is a lie the login
   *      screen cannot recover from. A number-SPECIFIC refusal is still
   *      swallowed, because answering differently for one number is the
   *      enumeration oracle the `202` contract exists to prevent.
   */
  async issueChallenge(
    phoneE164: string,
    purpose: OtpPurpose,
    context: AuthRequestContext,
  ): Promise<IssuedOtpChallenge> {
    const now = new Date();

    await this.pruneStaleChallenges(now);
    // DELIBERATELY PURPOSE-INDEPENDENT (V1 provider account deletion). The
    // cooldown and the rolling budget exist to protect a real handset from
    // being bombed with messages, and a message costs the recipient the same
    // whether its purpose was `login` or `account_deletion` — so both
    // continue to count EVERY challenge for the number. A deletion request
    // made seconds after a login request therefore still waits out the same
    // cooldown, by design. Only the LIVE SLOT below is namespaced by
    // purpose, and only so the two flows cannot CONSUME each other's live
    // codes; see `PhoneOtpChallenge.liveKey`'s schema comment.
    await this.assertRequestAllowed(phoneE164, now);

    await this.retireSlotIfNoLongerEntitled(phoneE164, purpose, now);

    const code = generateOtpCode();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    const authConfig = this.configService.get('auth', { infer: true })!;

    try {
      await this.prisma.phoneOtpChallenge.create({
        data: {
          phoneE164,
          purpose,
          // Claims this (purpose, number) pair's single live slot. A
          // concurrent request that already claimed it makes this INSERT
          // lose the unique index.
          liveKey: liveKeyFor(purpose, phoneE164),
          codeHash: this.hashOtpCode(purpose, phoneE164, code),
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

    await this.deliverOrWithdraw(phoneE164, purpose, code, expiresAt, now);

    return {
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      resendAvailableInSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
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
    purpose: OtpPurpose,
    now: Date,
  ): Promise<void> {
    await this.prisma.phoneOtpChallenge.updateMany({
      where: {
        phoneE164,
        // Scoped to the slot this request is about to claim. Retiring
        // another purpose's live challenge here would silently cancel a code
        // the user is holding in a different flow.
        purpose,
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
  async claimChallenge(
    phoneE164: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<void> {
    const now = new Date();

    // At most one row can match: `PhoneOtpChallenge.liveKey`'s unique index
    // guarantees one live challenge per number. `orderBy` is kept as
    // belt-and-braces so this stays deterministic even if that invariant
    // were ever relaxed — it must never become "whichever row the planner
    // returned first".
    const challenge = await this.prisma.phoneOtpChallenge.findFirst({
      // `purpose` IS THE SECURITY-CRITICAL PART OF THIS FILTER, not a
      // refinement: without it, a code sent for `account_deletion` could be
      // presented at `POST /auth/whatsapp/otp/verify` and would mint a
      // session (or a brand-new account) for the number — turning a
      // "confirm you want to delete this" message into a login credential.
      where: { phoneE164, purpose, consumedAt: null },
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
        this.hashOtpCode(purpose, phoneE164, code),
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
   * V1 PROVIDER ACCOUNT DELETION — destroys every outstanding challenge for
   * a number, of ANY purpose, once the account that owned it has been
   * deleted.
   *
   * WHY IT EXISTS. `PhoneOtpChallenge` deliberately has no `userId` and no
   * foreign key (see the model's schema comment: an OTP is requested for a
   * NUMBER, and at request time the server must not be able to say whether
   * that number has an account). That is the right design, and its exact
   * cost is that account deletion's `ON DELETE CASCADE` reaches nothing
   * here — a live code delivered moments before the delete would otherwise
   * outlive the account by up to `OTP_TTL_MS`. Nothing catastrophic follows
   * from that (the person still owns the handset, and after deletion the
   * identity row is gone so a login code could only ever create a NEW, empty
   * account), but "every credential-shaped artifact belonging to the deleted
   * account is destroyed with it" is a property worth actually having rather
   * than arguing about.
   *
   * NOT PURPOSE-SCOPED, unlike every other query in this file: the account
   * is gone, so no purpose's challenge for its number is still wanted.
   *
   * A SINGLE-STATEMENT, AUTO-COMMIT WRITE, and it MUST stay one. The
   * CANONICAL AUTH LOCK ORDER block in `auth.service.ts` records that this
   * table is deliberately kept out of every multi-statement transaction, so
   * it can never supply an edge to a deadlock cycle. `AuthService`
   * accordingly calls this AFTER its deletion transaction has committed,
   * never inside it.
   *
   * Failure is logged and swallowed: the account is already, durably
   * deleted, and turning a best-effort cleanup into a 500 would tell the
   * caller their deletion failed when it did not.
   */
  async purgeChallengesForPhone(phoneE164: string): Promise<void> {
    try {
      await this.prisma.phoneOtpChallenge.deleteMany({ where: { phoneE164 } });
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Failed to purge PhoneOtpChallenge rows for a deleted account's number ...${phoneE164.slice(-4)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
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

  /**
   * Hands the code to the provider and decides what a failure MEANS.
   *
   * ===================== THE TWO OUTCOMES, AND WHY =====================
   *
   * `recipient_rejected` — SWALLOWED, exactly as every delivery failure used
   * to be. The provider refused this destination specifically, so answering
   * differently would tell an unauthenticated caller something true about
   * one number that they could not learn about another. The challenge is
   * left live so the response is byte-identical to a successful send, and
   * the operator sees the reason in the log.
   *
   * `provider_unavailable` — PROPAGATED, after withdrawing the challenge.
   * This is the change this work unit exists to make. The failure is
   * number-independent by definition (see `WhatsAppDeliveryFailureKind`), so
   * surfacing it reveals nothing: the same request for any number fails the
   * same way. And it must be surfaced, because the alternative is a login
   * screen that says "we sent you a code" during a total delivery outage,
   * which is the single worst thing this endpoint can do.
   *
   * ANYTHING ELSE — an implementation that threw something other than a
   * `WhatsAppDeliveryError` — is treated as `provider_unavailable`. That is
   * the fail-closed reading: an unclassified throw is a failure nobody has
   * reasoned about, and quietly claiming success is never the safe response
   * to a surprise.
   *
   * THE WITHDRAWAL IS NOT OPTIONAL. Leaving the row in place would bill an
   * outage to the user twice over — a cooldown they must wait out and a slot
   * out of their hourly budget — for a code that was never sent. Deleting it
   * is safe precisely because nothing was sent: there is no message anyone
   * could be replaying, and no bombing that a retained row would be evidence
   * of.
   */
  private async deliverOrWithdraw(
    phoneE164: string,
    purpose: OtpPurpose,
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
      return;
    } catch (error) {
      // Never the code, and never the full number — this line is the one
      // thing about OTP delivery that plausibly ends up in a shared log.
      // Provider messages are contractually secret-free (see
      // `WhatsAppDeliveryError`), and are redacted again anyway.
      this.logger.error(
        redactSensitiveText(
          `WhatsApp OTP delivery failed for ...${phoneE164.slice(-4)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );

      if (
        error instanceof WhatsAppDeliveryError &&
        error.kind === 'recipient_rejected'
      ) {
        return;
      }

      await this.withdrawChallenge(phoneE164, purpose);

      throw new OtpDeliveryFailed(
        error instanceof WhatsAppDeliveryError ? error.httpStatus : undefined,
      );
    }
  }

  /**
   * Removes this number's live challenge after a delivery that definitively
   * did not happen, so the failed attempt costs the user neither a cooldown
   * nor a slot in their rolling budget.
   *
   * Scoped by `consumedAt: null` so it can only ever remove a LIVE row: a
   * concurrent verify that consumed the challenge between the send and this
   * cleanup has already released `liveKey` itself, and deleting a consumed
   * row would destroy the record of a code that genuinely was used.
   *
   * Failure is logged and swallowed. The caller is about to be told the send
   * failed either way, and turning a cleanup problem into a different error
   * would only make the outage harder to read.
   */
  private async withdrawChallenge(
    phoneE164: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    try {
      await this.prisma.phoneOtpChallenge.deleteMany({
        // Purpose-scoped for the same reason `retireSlotIfNoLongerEntitled`
        // is: a failed deletion-code send must not destroy a live login code
        // (or the reverse) that the user is still holding.
        where: { phoneE164, purpose, consumedAt: null },
      });
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `Failed to withdraw an undelivered PhoneOtpChallenge for ...${phoneE164.slice(-4)}: ${
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
   * THE PURPOSE TAG (V1 provider account deletion) is mixed in alongside the
   * fixed domain tag — see `OTP_PURPOSE_HASH_DOMAINS` for why `login` maps to
   * the empty string and therefore keeps its historical hash input unchanged.
   * It is defense in depth BEHIND `claimChallenge`'s `purpose` filter, not
   * instead of it: even a future query that forgot the filter could not match
   * a hash minted under a different purpose.
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
  private hashOtpCode(
    purpose: OtpPurpose,
    phoneE164: string,
    code: string,
  ): string {
    const authConfig = this.configService.get('auth', { infer: true })!;
    return createHmac('sha256', authConfig.jwtRefreshSecret)
      .update(OTP_CODE_HASH_DOMAIN)
      .update(OTP_PURPOSE_HASH_DOMAINS[purpose])
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
/**
 * V1 PROVIDER ACCOUNT DELETION — the value that claims
 * `PhoneOtpChallenge.liveKey`'s unique index for one (purpose, number) pair.
 *
 * ONE FUNCTION, so the format is defined exactly once: the insert that
 * claims a slot and the migration that backfilled the pre-existing rows must
 * agree byte-for-byte, and a second hand-written `${purpose}:${phone}` would
 * be one rename away from silently letting two live challenges coexist.
 * `':'` cannot occur in either half (a purpose comes from `OTP_PURPOSES`, a
 * number is E.164 digits after `normalizePhoneToE164`), so the concatenation
 * is unambiguous.
 */
function liveKeyFor(purpose: OtpPurpose, phoneE164: string): string {
  return `${purpose}:${phoneE164}`;
}

function constantTimeHexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
