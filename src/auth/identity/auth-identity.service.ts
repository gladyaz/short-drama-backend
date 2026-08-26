import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthIdentity } from '@prisma/client';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { RootConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyUniqueViolation } from './unique-violation';
import { AuthAuditService } from '../auth-audit.service';
import { AuthService } from '../auth.service';
import { AuthRequestContext, AuthResponseDto } from '../auth.types';
import { AuthProvider, LinkableAuthProvider } from './auth-identity.constants';
import {
  AuthIdentitySummaryDto,
  WhatsAppOtpRequestResponseDto,
} from './auth-identity.types';
import { GoogleSignInDto } from './dto/google-sign-in.dto';
import {
  WhatsAppOtpRequestDto,
  WhatsAppOtpVerifyDto,
} from './dto/whatsapp-otp.dto';
import {
  GoogleTokenRejected,
  invalidGoogleToken,
} from './google/google-id-token.util';
import { GOOGLE_IDENTITY_VERIFIER } from './google/google-identity.types';
// `import type` is REQUIRED for interfaces referenced in a decorated
// constructor signature under `isolatedModules` + `emitDecoratorMetadata`
// (TS1272): an interface has no runtime value for the emitted design-time
// metadata to reference. The DI token above is a real value and is imported
// normally.
import type {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './google/google-identity.types';
import {
  maskPhoneE164,
  normalizePhoneToE164,
} from './whatsapp/phone-normalization.util';
import {
  OtpDeliveryFailed,
  OtpRejected,
  OtpRequestThrottled,
  WhatsAppOtpService,
} from './whatsapp/whatsapp-otp.service';
import type { IssuedOtpChallenge } from './whatsapp/whatsapp-otp.service';

/**
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS.
 *
 * Owns the provider-NEUTRAL half of authentication: turning a PROVEN
 * external identity into a Short Drama session, creating an account when the
 * identity is genuinely new, refusing when it collides with an existing
 * account, and managing explicit link/unlink for an authenticated caller.
 *
 * Google's token verification lives behind `GoogleIdentityVerifier`; the
 * WhatsApp OTP challenge lifecycle lives behind `WhatsAppOtpService`. What
 * remains here is the part that is the same for every provider — which is
 * exactly the point.
 *
 * ============ THREE THINGS THIS CLASS DELIBERATELY DOES NOT DO ============
 *
 * 1. IT DOES NOT ISSUE SESSIONS ITSELF. Every successful outcome ends in
 *    `AuthService`'s existing, hardened session-issuance path, holding the
 *    same canonical `User`-row lock, writing the same `Session` row, and
 *    returning the same `accessToken`/`refreshToken` pair
 *    `register`/`login`/`refresh` return. There is no "social session", no
 *    second token format and no second revocation story: `POST
 *    /auth/refresh`, `/auth/logout`, `/auth/logout-all`, `GET
 *    /auth/sessions` and `DELETE /auth/sessions/:id` behave identically for
 *    a session created by Google, by WhatsApp or by a password — including
 *    refresh rotation and reuse detection. Entitlements, saved items, watch
 *    progress and payments continue to belong to the same `User.id` because
 *    there is only ever one `User.id`.
 *
 * 2. IT DOES NOT TOUCH PASSWORD CREDENTIALS. `User.passwordHash` is written
 *    only by `AuthService.register`/`.changePassword`/
 *    `.confirmPasswordReset`. A link or unlink can never add or remove a
 *    password, so linking cannot become a back door around the hardened
 *    credential-mutation invariants (revoke-all-sessions, reset-token
 *    invalidation, lock ordering) those methods enforce.
 *
 * 3. IT DOES NOT TRUST ANYTHING A CLIENT CLAIMS ABOUT AN IDENTITY. The only
 *    client-supplied inputs are an opaque Google ID token and a phone/code
 *    pair. Subject, email and display name are read out of a
 *    cryptographically verified token; a phone identity exists only after a
 *    code delivered to that number is presented back.
 *
 * ==================== LOCK ORDER (see `auth.service.ts`) ====================
 *
 * Every multi-statement transaction here takes the account's `User` row lock
 * as its FIRST statement, per the CANONICAL AUTH LOCK ORDER block in
 * `auth.service.ts`, where `AuthIdentity` is rank 2. The one transaction
 * that takes no lock — new-account creation — writes nothing but INSERTs of
 * rows that did not previously exist, so it has no row another transaction
 * could already hold.
 */
@Injectable()
export class AuthIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    private readonly authService: AuthService,
    private readonly authAuditService: AuthAuditService,
    private readonly whatsAppOtpService: WhatsAppOtpService,
    @Inject(GOOGLE_IDENTITY_VERIFIER)
    private readonly googleVerifier: GoogleIdentityVerifier,
  ) {}

  // ======================================================================
  // GOOGLE
  // ======================================================================

  /**
   * `POST /auth/google` — sign in OR sign up with a Google ID token.
   *
   * The token is verified server-side FIRST; only then is anything looked up
   * or created. Outcomes, in the order they are decided:
   *   - the Google `sub` already has an identity → SIGN IN to that account;
   *   - the `sub` is new and its VERIFIED email matches an existing account
   *     → refuse with `AUTH_ACCOUNT_LINK_REQUIRED`, creating nothing (see
   *     that error code for the account-takeover reasoning);
   *   - the `sub` is new and collides with nothing → CREATE a Short Drama
   *     account plus its Google identity, and sign in.
   */
  async signInWithGoogle(
    dto: GoogleSignInDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponseDto> {
    const verified = await this.verifyGoogleToken(dto.idToken, context);

    return this.resolveIdentitySignIn(
      {
        provider: 'google',
        providerSubject: verified.subject,
        normalizedIdentifier: verified.email ?? null,
        email: verified.email ?? null,
        displayName: verified.displayName ?? null,
      },
      context,
    );
  }

  /**
   * `POST /auth/identities/google/link` — attach a Google identity to the
   * ALREADY AUTHENTICATED caller's account.
   *
   * This is the supported answer to `AUTH_ACCOUNT_LINK_REQUIRED`, and it is
   * safe precisely because it demands proof of BOTH sides in one request: a
   * valid Short Drama access token (control of the existing account) AND a
   * valid Google ID token (control of the Google account). Neither alone
   * suffices, which is what makes provider collision a non-path to takeover.
   */
  async linkGoogle(
    userId: string,
    dto: GoogleSignInDto,
    context: AuthRequestContext = {},
  ): Promise<AuthIdentitySummaryDto[]> {
    const verified = await this.verifyGoogleToken(dto.idToken, context);

    return this.linkIdentity(
      userId,
      'google',
      verified.subject,
      verified.email ?? null,
      context,
    );
  }

  /**
   * Verifies a Google ID token through the injected port, converting the
   * internal `GoogleTokenRejected` signal into the generic client-facing
   * error while recording the SPECIFIC reason server-side. The feature-flag
   * check runs first so a server without Google configured answers a
   * truthful `503 GOOGLE_AUTH_DISABLED` rather than a misleading "invalid
   * credential".
   */
  private async verifyGoogleToken(
    idToken: string,
    context: AuthRequestContext,
  ): Promise<GoogleVerifiedIdentity> {
    this.assertGoogleEnabled();

    try {
      return await this.googleVerifier.verifyIdToken(idToken);
    } catch (error) {
      if (error instanceof GoogleTokenRejected) {
        await this.authAuditService.emit('identity_login_failed', {
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { provider: 'google', reason: error.reason },
        });
        throw invalidGoogleToken();
      }
      // An `AppException` from the verifier (e.g. the disabled stub's
      // `GOOGLE_AUTH_DISABLED`) is already the right answer and passes
      // through untouched. Anything else is a genuine, unexpected failure
      // and must keep surfacing as a 500 rather than being laundered into
      // "invalid credential" — the same reasoning `persistSession`'s
      // deliberately narrow catch applies in `auth.service.ts`.
      throw error;
    }
  }

  private assertGoogleEnabled(): void {
    if (!this.identityConfig().googleEnabled) {
      throw new AppException(
        AppErrorCode.GOOGLE_AUTH_DISABLED,
        'Google sign-in is not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  // ======================================================================
  // WHATSAPP
  // ======================================================================

  /**
   * `POST /auth/whatsapp/otp/request` — issue and deliver a one-time code.
   *
   * ALWAYS answers `202` when it answers at all, whether or not the number
   * belongs to an existing account — the same frozen anti-enumeration
   * contract as `POST /auth/password-reset/request`.
   *
   * EXACTLY TWO observable deviations exist, and neither reveals whether an
   * ACCOUNT exists:
   *   - `429 OTP_RESEND_COOLDOWN` — per-number, and therefore an accepted,
   *     documented tradeoff. See that error code.
   *   - `503 WHATSAPP_PROVIDER_UNAVAILABLE` — number-INDEPENDENT, and
   *     therefore not a tradeoff at all: an outage answers every number the
   *     same way. See that error code for why answering `202` during a
   *     delivery outage is the one thing this endpoint must not do.
   *
   * Normalization happens before any database access, so a malformed number
   * costs nothing and reveals nothing.
   */
  async requestOtp(
    dto: WhatsAppOtpRequestDto,
    context: AuthRequestContext = {},
  ): Promise<WhatsAppOtpRequestResponseDto> {
    this.assertWhatsAppEnabled();

    const phoneE164 = normalizePhoneToE164(dto.phone);

    let issued: IssuedOtpChallenge;
    try {
      issued = await this.whatsAppOtpService.issueChallenge(phoneE164, context);
    } catch (error) {
      if (error instanceof OtpRequestThrottled) {
        await this.authAuditService.emit('otp_request_throttled', {
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { reason: error.reason },
        });
        throw new AppException(
          AppErrorCode.OTP_RESEND_COOLDOWN,
          'A verification code was already requested for this number recently. Please wait before requesting another.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof OtpDeliveryFailed) {
        // The challenge has already been withdrawn by `WhatsAppOtpService`,
        // so "try again" is honest advice rather than a suggestion the
        // cooldown will immediately refuse. The provider's HTTP status is
        // deliberately NOT echoed to the caller — it is an operator
        // diagnostic, and it is already in the log.
        await this.authAuditService.emit('otp_delivery_failed', {
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { reason: 'provider_unavailable' },
        });
        throw new AppException(
          AppErrorCode.WHATSAPP_PROVIDER_UNAVAILABLE,
          'The verification code could not be sent right now. Please try again in a moment.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }

    // No `userId` and no metadata: at request time the server does not know
    // whether this number belongs to an account, and the number itself is
    // never written to the audit trail.
    await this.authAuditService.emit('otp_requested', {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      success: true,
      expiresInSeconds: issued.expiresInSeconds,
      resendAvailableInSeconds: issued.resendAvailableInSeconds,
      devCode: issued.devCode,
    };
  }

  /**
   * `POST /auth/whatsapp/otp/verify` — prove ownership of a phone number and
   * sign in (or sign up).
   *
   * A verified phone identity that already exists is a LOGIN; one that is
   * genuinely new creates a Short Drama account. There is no collision case
   * to handle the way there is for a Google email, because a phone number is
   * never stored on `User` and never compared against one — the only thing a
   * normalized number can match is another `whatsapp` identity, which by
   * definition means "the same person signing in again".
   */
  async verifyOtp(
    dto: WhatsAppOtpVerifyDto,
    context: AuthRequestContext = {},
  ): Promise<AuthResponseDto> {
    const phoneE164 = await this.consumeOtp(dto, context);

    return this.resolveIdentitySignIn(
      {
        provider: 'whatsapp',
        providerSubject: phoneE164,
        normalizedIdentifier: phoneE164,
        email: null,
        displayName: null,
      },
      context,
    );
  }

  /**
   * `POST /auth/identities/whatsapp/link` — attach a phone identity to the
   * ALREADY AUTHENTICATED caller's account, proving ownership of the number
   * in the same request by consuming a real OTP. Same both-sides-proof
   * property as `linkGoogle`.
   */
  async linkWhatsApp(
    userId: string,
    dto: WhatsAppOtpVerifyDto,
    context: AuthRequestContext = {},
  ): Promise<AuthIdentitySummaryDto[]> {
    const phoneE164 = await this.consumeOtp(dto, context);

    return this.linkIdentity(userId, 'whatsapp', phoneE164, phoneE164, context);
  }

  /**
   * Normalizes, then verifies-and-consumes the OTP, returning the number the
   * caller has now PROVEN they control. Converts the internal
   * `OtpRejected` signal into the generic client-facing `INVALID_OTP` while
   * recording the specific reason server-side — the same "generic response,
   * disambiguated audit reason" split `login_failed` uses.
   */
  private async consumeOtp(
    dto: WhatsAppOtpVerifyDto,
    context: AuthRequestContext,
  ): Promise<string> {
    this.assertWhatsAppEnabled();

    const phoneE164 = normalizePhoneToE164(dto.phone);

    try {
      await this.whatsAppOtpService.claimChallenge(phoneE164, dto.code);
      return phoneE164;
    } catch (error) {
      if (error instanceof OtpRejected) {
        await this.authAuditService.emit('identity_login_failed', {
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { provider: 'whatsapp', reason: error.reason },
        });
        throw invalidOtp();
      }
      throw error;
    }
  }

  private assertWhatsAppEnabled(): void {
    if (!this.identityConfig().whatsappEnabled) {
      throw new AppException(
        AppErrorCode.WHATSAPP_AUTH_DISABLED,
        'WhatsApp sign-in is not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  // ======================================================================
  // PROVIDER-NEUTRAL IDENTITY RESOLUTION
  // ======================================================================

  /**
   * The single place where a PROVEN external identity becomes a Short Drama
   * session. Both providers funnel through here, so "Google and WhatsApp
   * behave identically" is a structural property of the code rather than a
   * convention two parallel code paths have to keep agreeing on.
   */
  private async resolveIdentitySignIn(
    identity: NewIdentityInput,
    context: AuthRequestContext,
    isRetry = false,
  ): Promise<AuthResponseDto> {
    const existing = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: identity.provider,
          providerSubject: identity.providerSubject,
        },
      },
      select: { userId: true },
    });

    if (existing) {
      const response = await this.authService.issueSessionForIdentity(
        existing.userId,
        context,
      );

      await this.authAuditService.emit('identity_login_success', {
        userId: existing.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { provider: identity.provider, outcome: 'signed_in' },
      });

      return response;
    }

    await this.assertNoAccountCollision(identity, context);

    try {
      return await this.createAccountForIdentity(identity, context);
    } catch (error) {
      const violation = classifyUniqueViolation(error);

      // A concurrent FIRST sign-in for the very same external identity won
      // the insert. That is not an error — it is the same human, and the
      // account they belong in now exists. Re-resolve ONCE, which takes the
      // "existing identity" branch above and signs them in. Bounded to a
      // single retry so no pathological loop is possible.
      if (violation === 'identity_subject' && !isRetry) {
        return this.resolveIdentitySignIn(identity, context, true);
      }

      // A concurrent registration claimed this email between the collision
      // check and the insert. `AUTH_ACCOUNT_LINK_REQUIRED` is the same
      // conclusion the collision check would have reached a moment later, so
      // the race produces the correct outcome rather than a 500.
      if (violation === 'user_email') {
        await this.emitLinkRequired(identity.provider, context, undefined);
        throw accountLinkRequired();
      }

      throw error;
    }
  }

  /**
   * THE ACCOUNT-TAKEOVER BOUNDARY.
   *
   * A brand-new external identity whose VERIFIED email matches an existing
   * account is refused outright — nothing is created, nothing is linked, no
   * session is issued. See `AppErrorCode.AUTH_ACCOUNT_LINK_REQUIRED` for the
   * full reasoning; in short, matching strings are not proof of ownership,
   * and the supported path (authenticate normally, then link) requires
   * proving both sides.
   *
   * BOTH places an email can already live are checked: `User.email` (what
   * `register`/`login` use) and an `email` `AuthIdentity` row (what the
   * migration backfilled and what `register` now also writes). They should
   * never disagree; checking both means a future divergence fails CLOSED —
   * refusing a link that might have been fine — rather than open.
   *
   * An UNVERIFIED provider email arrives here as `null` (dropped by
   * `validateGoogleClaims`) and therefore matches nothing. That is the
   * correct fail-closed direction: an unverified address is not evidence the
   * caller controls it, so it must neither unlock an existing account nor be
   * recorded as the new account's email.
   */
  private async assertNoAccountCollision(
    identity: NewIdentityInput,
    context: AuthRequestContext,
  ): Promise<void> {
    if (!identity.email) {
      return;
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: identity.email },
      select: { id: true },
    });

    if (existingUser) {
      await this.emitLinkRequired(identity.provider, context, existingUser.id);
      throw accountLinkRequired();
    }

    const existingEmailIdentity = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: 'email',
          providerSubject: identity.email,
        },
      },
      select: { userId: true },
    });

    if (existingEmailIdentity) {
      await this.emitLinkRequired(
        identity.provider,
        context,
        existingEmailIdentity.userId,
      );
      throw accountLinkRequired();
    }
  }

  private async emitLinkRequired(
    provider: AuthProvider,
    context: AuthRequestContext,
    targetUserId: string | undefined,
  ): Promise<void> {
    await this.authAuditService.emit('identity_link_required', {
      userId: targetUserId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { provider },
    });
  }

  /**
   * Creates a brand-new Short Drama account for a genuinely new external
   * identity, then issues a session for it.
   *
   * `User` and `AuthIdentity` are written in ONE transaction: an account row
   * can never exist without the identity row that says how to sign into it.
   * Both statements are INSERTs of rows that did not previously exist, so
   * this transaction holds no lock another transaction could already own and
   * cannot participate in the deadlock cycle the CANONICAL AUTH LOCK ORDER
   * block prevents — which is why it correctly takes no `lockAccountRow`
   * (there is no row to lock yet).
   *
   * Fix cycle 1 (Reviewer B, finding 2): the `Session` row is DELIBERATELY
   * NOT part of that transaction, and this is the corrected shape. Writing
   * it here would mean signing the access token inside the transaction —
   * the `sub` claim is the id of the row being inserted, so it cannot be
   * signed beforehand — and `AuthService`'s standing rule (see
   * `prepareTokenPair`'s doc comment) is that `await`ed crypto must never
   * run while a transaction holds a pooled connection, because a starved
   * `signAsync` turns a successful request into an opaque `P2028`.
   *
   * `issueSessionForIdentity` is therefore called normally, after the commit
   * — the exact same call a RETURNING user's sign-in makes, which is a
   * bonus: new and returning accounts now issue sessions through one code
   * path instead of two. A failure strictly between the commit and session
   * issuance leaves a real, usable account with no session; the caller signs
   * in again and takes the existing-identity branch. Self-healing, and
   * strictly better than the alternative of stranding a half-created
   * account.
   *
   * `passwordHash` is left NULL — this account has no password, and writing
   * a random unusable hash instead would be indistinguishable from a real
   * credential at every `bcrypt.compare` call site.
   */
  private async createAccountForIdentity(
    identity: NewIdentityInput,
    context: AuthRequestContext,
  ): Promise<AuthResponseDto> {
    const now = new Date();

    const userId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: identity.email,
          passwordHash: null,
          displayName: identity.displayName,
        },
        select: { id: true },
      });

      await tx.authIdentity.create({
        data: {
          userId: user.id,
          provider: identity.provider,
          providerSubject: identity.providerSubject,
          normalizedIdentifier: identity.normalizedIdentifier,
          // The provider's ownership proof was accepted moments ago, so this
          // timestamp records a verification that genuinely happened —
          // unlike the deliberately-NULL `verifiedAt` on the email rows the
          // migration backfilled.
          verifiedAt: now,
        },
      });

      return user.id;
    });

    const response = await this.authService.issueSessionForIdentity(
      userId,
      context,
    );

    await this.authAuditService.emit('identity_login_success', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { provider: identity.provider, outcome: 'registered' },
    });

    return response;
  }

  // ======================================================================
  // LINKING
  // ======================================================================

  /**
   * Attaches a proven external identity to an ALREADY AUTHENTICATED account.
   *
   * LOCK ORDER: `User` (rank 1, `FOR SHARE`) then `AuthIdentity` (rank 2).
   * `FOR SHARE` is the weakest mode that works and therefore the right one:
   * this transaction does not write the `User` row, it only needs to be
   * ORDERED against the credential mutators and `deleteAccount` (whose
   * `FOR NO KEY UPDATE`/`FOR UPDATE` it conflicts with), while staying
   * compatible with itself and with `login`/`requestPasswordReset` so
   * ordinary traffic for the same account is never serialized behind a link.
   *
   * Because `FOR SHARE` is self-compatible, two concurrent links for the
   * same account can both pass the pre-flight checks — which is precisely
   * why the `P2002` handling below is load-bearing rather than defensive:
   * the DATABASE decides, and the loser receives the same specific error the
   * pre-flight check would have produced.
   *
   * DELIBERATELY DOES NOT WRITE `User.email`, even when linking a Google
   * identity to an account that has none. Silently giving an account an
   * email address would silently give it a `POST
   * /auth/password-reset/request` surface — a new way in, created as a side
   * effect of a request that only asked to link a provider.
   */
  private async linkIdentity(
    userId: string,
    provider: LinkableAuthProvider,
    providerSubject: string,
    normalizedIdentifier: string | null,
    context: AuthRequestContext,
  ): Promise<AuthIdentitySummaryDto[]> {
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        const accountExists = await this.authService.lockAccountRowForIdentity(
          tx,
          userId,
          'share',
        );
        if (!accountExists) {
          throw accountVanished();
        }

        const existing = await tx.authIdentity.findUnique({
          where: { provider_providerSubject: { provider, providerSubject } },
          select: { userId: true },
        });

        if (existing) {
          if (existing.userId === userId) {
            // Already linked to THIS account: idempotent success. A client
            // retrying a request whose response it never received must not
            // be punished with a 409 for a state that is already exactly
            // what it asked for.
            return;
          }
          throw identityAlreadyLinked();
        }

        const ownProviderIdentity = await tx.authIdentity.findUnique({
          where: { userId_provider: { userId, provider } },
          select: { id: true },
        });

        if (ownProviderIdentity) {
          throw providerAlreadyLinked();
        }

        await tx.authIdentity.create({
          data: {
            userId,
            provider,
            providerSubject,
            normalizedIdentifier,
            verifiedAt: now,
          },
        });
      });
    } catch (error) {
      const raced = classifyUniqueViolation(error);

      if (raced === 'identity_subject') {
        await this.emitLinkFailed(provider, 'already_linked', userId, context);
        throw identityAlreadyLinked();
      }
      if (raced === 'identity_user_provider') {
        await this.emitLinkFailed(provider, 'provider_taken', userId, context);
        throw providerAlreadyLinked();
      }

      if (error instanceof AppException) {
        const reason = LINK_FAILURE_REASONS[error.code];
        if (reason) {
          await this.emitLinkFailed(provider, reason, userId, context);
        }
      }
      throw error;
    }

    await this.authAuditService.emit('identity_linked', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { provider },
    });

    return this.listIdentities(userId);
  }

  /**
   * `DELETE /auth/identities/:provider` — remove one of the caller's own
   * linked providers.
   *
   * REFUSES TO REMOVE THE LAST USABLE WAY IN. "Usable" is evaluated against
   * real credentials rather than row counts: an `email` identity counts only
   * while `User.passwordHash` is non-null, because an account that never had
   * a password cannot log in with one. Without that distinction a
   * Google-created account (a `google` identity, no password) could unlink
   * Google, satisfy a naive "one identity row still exists" check, and be
   * permanently locked out.
   *
   * LOCK ORDER: `User` (rank 1) then `AuthIdentity` (rank 2), with
   * `FOR NO KEY UPDATE` rather than `FOR SHARE`. The stronger,
   * SELF-CONFLICTING mode is load-bearing here: two concurrent unlinks of
   * DIFFERENT providers on the same account would each observe the other's
   * identity still present, each conclude "one usable method remains", and
   * both succeed — leaving the account with none. Serializing them per
   * account is what makes the last-method rule an actual invariant rather
   * than a check that only holds when nobody is racing.
   *
   * DELIBERATELY DOES NOT REVOKE SESSIONS. Unlinking removes a way to obtain
   * NEW sessions; it is not an assertion that existing ones are compromised.
   * `POST /auth/logout-all` exists for that, and signing a user out of every
   * device as a side effect of tidying up their linked accounts would be a
   * surprising action nobody requested.
   */
  async unlinkIdentity(
    userId: string,
    provider: LinkableAuthProvider,
    context: AuthRequestContext = {},
  ): Promise<AuthIdentitySummaryDto[]> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await this.authService.lockAccountRowForIdentity(
          tx,
          userId,
          'no-key-update',
        );
        if (!locked) {
          throw accountVanished();
        }

        const account = await tx.user.findUnique({
          where: { id: userId },
          select: { passwordHash: true },
        });
        if (!account) {
          throw accountVanished();
        }

        const identities = await tx.authIdentity.findMany({
          where: { userId },
        });

        const target = identities.find((row) => row.provider === provider);
        if (!target) {
          throw identityNotFound();
        }

        const remainingUsable = identities.filter(
          (row) =>
            row.id !== target.id && isUsableIdentity(row, account.passwordHash),
        );

        if (remainingUsable.length === 0) {
          throw lastIdentity();
        }

        await tx.authIdentity.delete({ where: { id: target.id } });
      });
    } catch (error) {
      if (error instanceof AppException) {
        const reason = LINK_FAILURE_REASONS[error.code];
        if (reason) {
          await this.emitLinkFailed(provider, reason, userId, context);
        }
      }
      throw error;
    }

    await this.authAuditService.emit('identity_unlinked', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { provider },
    });

    return this.listIdentities(userId);
  }

  private async emitLinkFailed(
    provider: AuthProvider,
    reason: LinkFailureReason,
    userId: string,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.authAuditService.emit('identity_link_failed', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { provider, reason },
    });
  }

  /**
   * `GET /auth/identities` — the caller's OWN linked providers, never
   * another account's, and never a raw `providerSubject` (see
   * `AuthIdentitySummaryDto` for what is deliberately withheld and why).
   *
   * `canBeUnlinked` is computed here so the "do not remove your last way in"
   * rule has exactly one implementation, shared with `unlinkIdentity` — a
   * client rendering an unlink button from this flag and a server enforcing
   * the rule can never disagree.
   */
  async listIdentities(userId: string): Promise<AuthIdentitySummaryDto[]> {
    const [user, identities] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
      }),
      this.prisma.authIdentity.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!user) {
      throw accountVanished();
    }

    const usableCount = identities.filter((row) =>
      isUsableIdentity(row, user.passwordHash),
    ).length;

    return identities.map((row) => {
      const usable = isUsableIdentity(row, user.passwordHash);
      return {
        provider: row.provider as AuthProvider,
        identifier: presentIdentifier(row),
        usable,
        // Removing an unusable identity leaves the usable count unchanged;
        // removing a usable one reduces it by exactly one. Either way at
        // least one usable method must survive — and an `email` identity is
        // never removable through this route at all (see
        // `LINKABLE_AUTH_PROVIDERS`).
        canBeUnlinked:
          row.provider !== 'email' && usableCount - (usable ? 1 : 0) >= 1,
        createdAt: row.createdAt.toISOString(),
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
      };
    });
  }

  private identityConfig() {
    return this.configService.get('identityProviders', { infer: true })!;
  }
}

/** Everything needed to resolve — or create an account for — a proven identity. */
interface NewIdentityInput {
  provider: AuthProvider;
  providerSubject: string;
  normalizedIdentifier: string | null;
  /** The provider's VERIFIED email, or `null`. Never an unverified one. */
  email: string | null;
  displayName: string | null;
}

type LinkFailureReason =
  'already_linked' | 'provider_taken' | 'last_identity' | 'not_found';

/**
 * Maps the link/unlink error codes to their audit `reason`. A lookup table
 * rather than a chain of ternaries so that adding a code without deciding
 * what it audits as is a visible omission (`undefined`, no event emitted)
 * instead of a silently wrong label.
 */
const LINK_FAILURE_REASONS: Partial<Record<AppErrorCode, LinkFailureReason>> = {
  [AppErrorCode.AUTH_IDENTITY_ALREADY_LINKED]: 'already_linked',
  [AppErrorCode.AUTH_PROVIDER_ALREADY_LINKED]: 'provider_taken',
  [AppErrorCode.AUTH_LAST_IDENTITY]: 'last_identity',
  [AppErrorCode.AUTH_IDENTITY_NOT_FOUND]: 'not_found',
};

/**
 * An `email` identity can only sign in while the account actually has a
 * password; `google`/`whatsapp` identities are always usable once linked.
 * This one predicate is the single definition of "a way in", shared by
 * `listIdentities` and `unlinkIdentity`.
 */
function isUsableIdentity(
  identity: Pick<AuthIdentity, 'provider'>,
  passwordHash: string | null,
): boolean {
  return identity.provider === 'email' ? passwordHash !== null : true;
}

/**
 * The safe, client-facing rendering of an identity — an email as-is, a phone
 * number MASKED to its last four digits, and `null` for anything that
 * exposes neither safely (e.g. a Google account whose email was not
 * verified). Never the raw `providerSubject`.
 */
function presentIdentifier(
  identity: Pick<AuthIdentity, 'provider' | 'normalizedIdentifier'>,
): string | null {
  if (!identity.normalizedIdentifier) {
    return null;
  }
  return identity.provider === 'whatsapp'
    ? maskPhoneE164(identity.normalizedIdentifier)
    : identity.normalizedIdentifier;
}

function invalidOtp(): AppException {
  return new AppException(
    AppErrorCode.INVALID_OTP,
    'Invalid or expired verification code',
    HttpStatus.UNAUTHORIZED,
  );
}

function accountLinkRequired(): AppException {
  return new AppException(
    AppErrorCode.AUTH_ACCOUNT_LINK_REQUIRED,
    'An account already exists for this email address. Sign in with your existing method, then link this provider from your account settings.',
    HttpStatus.CONFLICT,
  );
}

function identityAlreadyLinked(): AppException {
  return new AppException(
    AppErrorCode.AUTH_IDENTITY_ALREADY_LINKED,
    'This identity is already linked to a different account',
    HttpStatus.CONFLICT,
  );
}

function providerAlreadyLinked(): AppException {
  return new AppException(
    AppErrorCode.AUTH_PROVIDER_ALREADY_LINKED,
    'This account already has a different identity linked for this provider. Unlink it first.',
    HttpStatus.CONFLICT,
  );
}

function lastIdentity(): AppException {
  return new AppException(
    AppErrorCode.AUTH_LAST_IDENTITY,
    'This is the only way to sign in to this account. Link another provider before removing it.',
    HttpStatus.CONFLICT,
  );
}

function identityNotFound(): AppException {
  return new AppException(
    AppErrorCode.AUTH_IDENTITY_NOT_FOUND,
    'No linked identity for this provider',
    HttpStatus.NOT_FOUND,
  );
}

/**
 * A concurrent `deleteAccount()` removed the account mid-request. Reported as
 * `INVALID_ACCESS_TOKEN`, matching `AuthService.deleteAccount`'s own
 * precedent for exactly this situation: the token names an account that no
 * longer exists, which is indistinguishable from — and best reported as — an
 * invalid token.
 */
function accountVanished(): AppException {
  return new AppException(
    AppErrorCode.INVALID_ACCESS_TOKEN,
    'Invalid or expired access token',
    HttpStatus.UNAUTHORIZED,
  );
}
