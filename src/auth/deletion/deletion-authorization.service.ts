import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { RootConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { DUMMY_HASH_FOR_TIMING_PARITY } from '../auth.constants';
import { AuthAuditService } from '../auth-audit.service';
import { AuthRequestContext } from '../auth.types';
import { AccountDeletionDto } from '../dto/account-deletion.dto';
import { resolveDeletionProofMethod } from '../dto/account-deletion.dto';
import { AuthProvider } from '../identity/auth-identity.constants';
import { GOOGLE_IDENTITY_VERIFIER } from '../identity/google/google-identity.types';
// `import type` is REQUIRED for an interface referenced in a decorated
// constructor signature under `isolatedModules` + `emitDecoratorMetadata`
// (TS1272) — same reason `AuthIdentityService` imports this token's type
// separately from the token itself.
import type { GoogleIdentityVerifier } from '../identity/google/google-identity.types';
import {
  GoogleTokenRejected,
  invalidGoogleToken,
} from '../identity/google/google-id-token.util';
import {
  OtpDeliveryFailed,
  OtpRejected,
  OtpRequestThrottled,
  WhatsAppOtpService,
} from '../identity/whatsapp/whatsapp-otp.service';
import type { IssuedOtpChallenge } from '../identity/whatsapp/whatsapp-otp.service';
import { WhatsAppOtpRequestResponseDto } from '../identity/auth-identity.types';
import {
  DELETION_PROOF_METHOD_BY_PROVIDER,
  DELETION_PROOF_METHODS,
  DeletionAuthorization,
  DeletionProofMethod,
} from './deletion-authorization.types';

/**
 * V1 PROVIDER ACCOUNT DELETION — the one place that decides whether an
 * authenticated caller has proven enough to have their account destroyed.
 *
 * See `deletion-authorization.types.ts` for the design rationale (why proof
 * is per-identity, why nothing weakens authentication, and why there is no
 * stored deletion token). This file is the implementation, and it exists as
 * its own service for one reason: `AuthService` is already 2,900 lines and
 * owns password credentials, sessions and the deletion transaction, while
 * the checks below need the Google verifier port and the WhatsApp OTP
 * service that `AuthService` deliberately does not depend on. Putting them
 * here keeps `AuthService.deleteAccount` a transaction, and keeps the proof
 * policy readable in one screen.
 *
 * ======================== IT REUSES, IT DOES NOT ADD ========================
 *
 * Every verification below runs through infrastructure that already existed
 * and is already reviewed and tested:
 *   - bcrypt against `User.passwordHash`, exactly as `login` does, including
 *     the explicit `null` refusal the schema comment demands and the
 *     `DUMMY_HASH_FOR_TIMING_PARITY` fallback that keeps latency constant;
 *   - `GoogleIdentityVerifier` — the SAME port `POST /auth/google` uses, so
 *     the RS256/JWKS/issuer/audience/expiry checks are the real ones and no
 *     test can reach Google;
 *   - `WhatsAppOtpService` — the SAME challenge lifecycle
 *     `POST /auth/whatsapp/otp/*` uses, so there is no second, fake OTP
 *     system; only its `purpose` differs.
 *
 * ===================== NO PROVIDER RE-AUTH MINTS A SESSION =====================
 *
 * Nothing here calls `AuthService.issueSessionForIdentity`, creates a
 * `User`, or writes an `AuthIdentity`. A Google token or an OTP presented at
 * a deletion route can ONLY authorize a deletion of the account that already
 * owns that identity — it can never sign anyone in, and it can never create
 * an account. For WhatsApp that property is enforced structurally by the
 * `account_deletion` challenge namespace (a deletion code does not exist in
 * the `login` namespace `POST /auth/whatsapp/otp/verify` reads), not merely
 * by this class's own restraint.
 */
@Injectable()
export class DeletionAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    private readonly authAuditService: AuthAuditService,
    private readonly whatsAppOtpService: WhatsAppOtpService,
    @Inject(GOOGLE_IDENTITY_VERIFIER)
    private readonly googleVerifier: GoogleIdentityVerifier,
  ) {}

  /**
   * `GET /users/me/deletion/methods` — which proofs THIS account can produce
   * on THIS server right now.
   *
   * A method is offered only when both halves hold: the account owns the
   * credential (a non-null `passwordHash`, or a linked `AuthIdentity` row),
   * AND this server can currently verify it (the provider's feature flag is
   * on). The flag half is not pedantry — with `GOOGLE_AUTH_ENABLED=false`
   * the verifier is `DisabledGoogleIdentityVerifier`, which rejects
   * everything, so offering `google` would be offering a door that is
   * painted on.
   *
   * ORDERED BY `DELETION_PROOF_METHODS` rather than by row order, so the
   * response is stable for a client that renders the first entry as its
   * default.
   */
  async availableMethods(userId: string): Promise<DeletionProofMethod[]> {
    const account = await this.loadAccount(userId);
    const available = new Set<DeletionProofMethod>();

    if (account.passwordHash !== null) {
      available.add('password');
    }

    for (const provider of account.providers) {
      const method = DELETION_PROOF_METHOD_BY_PROVIDER[provider];
      // `email` maps to `password`, which the `passwordHash` check above
      // already decided — an `email` identity row on an account whose
      // password has since become null is NOT a usable proof, exactly as
      // `isUsableIdentity` already defines it for sign-in.
      if (method !== 'password' && this.isProviderVerifiable(method)) {
        available.add(method);
      }
    }

    return DELETION_PROOF_METHODS.filter((method) => available.has(method));
  }

  /**
   * `POST /users/me/deletion/whatsapp/otp` — deliver a deletion code to the
   * number ALREADY LINKED to the authenticated caller's account.
   *
   * THE NUMBER IS NEVER TAKEN FROM THE REQUEST. It is read from this
   * account's own `AuthIdentity` row, which is what makes the resulting
   * challenge bound to this account: the code goes to the handset the
   * account is already signed in with, and no body field can redirect it.
   * That also means this authenticated route is NOT a new SMS-bombing lever
   * — a caller can only ever cause messages to their own linked number, and
   * `WhatsAppOtpService`'s per-number cooldown and rolling budget still
   * count every challenge for that number regardless of purpose.
   *
   * Failure modes are mapped to the SAME client-facing codes
   * `POST /auth/whatsapp/otp/request` already uses, so a client needs one
   * implementation of each: `429 OTP_RESEND_COOLDOWN` and
   * `503 WHATSAPP_PROVIDER_UNAVAILABLE`.
   */
  async requestWhatsAppChallenge(
    userId: string,
    context: AuthRequestContext = {},
  ): Promise<WhatsAppOtpRequestResponseDto> {
    const phoneE164 = await this.requireLinkedSubject(userId, 'whatsapp');

    let issued: IssuedOtpChallenge;
    try {
      issued = await this.whatsAppOtpService.issueChallenge(
        phoneE164,
        'account_deletion',
        context,
      );
    } catch (error) {
      if (error instanceof OtpRequestThrottled) {
        await this.authAuditService.emit('otp_request_throttled', {
          userId,
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
        await this.authAuditService.emit('otp_delivery_failed', {
          userId,
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

    await this.authAuditService.emit('account_deletion_challenge_requested', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { method: 'whatsapp' },
    });

    return {
      success: true,
      expiresInSeconds: issued.expiresInSeconds,
      resendAvailableInSeconds: issued.resendAvailableInSeconds,
      devCode: issued.devCode,
    };
  }

  /**
   * THE GATE. Verifies the proof named by `dto.method` against the
   * authenticated account, and returns the permission slip
   * `AuthService.deleteAccount` demands. Throws — never returns a falsy
   * value — when the proof does not hold, so a caller cannot forget to
   * check.
   *
   * ORDER OF CHECKS, and why:
   *   1. does the account still exist (a concurrent deletion already ran);
   *   2. can it produce the requested method at all -> `409
   *      ACCOUNT_DELETION_METHOD_UNAVAILABLE`, the honest answer that
   *      replaces the old misleading "invalid credentials" for passwordless
   *      accounts;
   *   3. does the presented credential verify -> the provider's own generic
   *      error (`INVALID_CREDENTIALS` / `INVALID_GOOGLE_TOKEN` /
   *      `INVALID_OTP`);
   *   4. does it belong to THIS account -> `401
   *      ACCOUNT_DELETION_PROOF_MISMATCH`.
   *
   * `User.role` is deliberately NOT checked here. It stays in
   * `AuthService.deleteAccount`, AFTER this returns, preserving that
   * method's documented ordering property: a privileged account presented
   * with a WRONG proof still gets the generic credential error rather than
   * the descriptive `403`, so a stolen access token alone never reveals that
   * an account is privileged.
   */
  async authorize(
    userId: string,
    dto: AccountDeletionDto,
    context: AuthRequestContext = {},
  ): Promise<DeletionAuthorization> {
    const method = resolveDeletionProofMethod(dto);
    const account = await this.loadAccount(userId);

    switch (method) {
      case 'password':
        return this.authorizeWithPassword(userId, account, dto, context);
      case 'google':
        return this.authorizeWithGoogle(userId, account, dto, context);
      case 'whatsapp':
        return this.authorizeWithWhatsApp(userId, account, dto, context);
    }
  }

  // ======================================================================
  // PASSWORD — PRESERVED EXACTLY
  // ======================================================================

  /**
   * Byte-for-byte the behavior `AuthService.deleteAccount` had before this
   * work unit, moved rather than rewritten: the same bcrypt comparison
   * against the same fallback constant, the same explicit `passwordHash ===
   * null` refusal the `User.passwordHash` schema comment requires of every
   * call site, the same generic `INVALID_CREDENTIALS` for a wrong password,
   * and the same audited reasons.
   *
   * ONE DELIBERATE CHANGE, and it is the fix itself: a `null` `passwordHash`
   * no longer answers `401 INVALID_CREDENTIALS` (audit reason
   * `no_password_credential`) but `409 ACCOUNT_DELETION_METHOD_UNAVAILABLE`
   * (audit reason `method_unavailable`), because telling the owner of a
   * Google-only account that their password is wrong is not merely unhelpful
   * — it is false. The refusal itself is unchanged: no password, no
   * password-based deletion.
   *
   * THE COMPARISON STILL RUNS ON A `null` HASH, against the dummy, before
   * the `null` check decides the outcome. That is not redundant work: it
   * keeps this path's latency indistinguishable from a real wrong-password
   * attempt, exactly as the original did.
   */
  private async authorizeWithPassword(
    userId: string,
    account: DeletionAccount,
    dto: AccountDeletionDto,
    context: AuthRequestContext,
  ): Promise<DeletionAuthorization> {
    const passwordMatches = await bcrypt.compare(
      dto.currentPassword ?? '',
      account.passwordHash ?? DUMMY_HASH_FOR_TIMING_PARITY,
    );

    if (account.passwordHash === null) {
      throw await this.refuse(
        userId,
        'password',
        'method_unavailable',
        context,
        methodUnavailable('password'),
      );
    }

    if (!passwordMatches) {
      throw await this.refuse(
        userId,
        'password',
        'invalid_current_password',
        context,
        invalidCredentials(),
      );
    }

    return { method: 'password', userId, whatsappPhoneE164: null };
  }

  // ======================================================================
  // GOOGLE
  // ======================================================================

  /**
   * A Google-only (or Google-linked) account deletes itself by presenting a
   * FRESH Google ID token — never a Red Panda password it may not have.
   *
   * ============ THE BINDING IS THE SECURITY PROPERTY, NOT THE TOKEN ============
   *
   * A validly-signed Google ID token proves the caller controls SOME Google
   * account. It says nothing about WHICH Red Panda account may be deleted.
   * So the verified `sub` is compared against this account's OWN
   * `AuthIdentity.providerSubject` for `provider: 'google'`, and a mismatch
   * is refused with `ACCOUNT_DELETION_PROOF_MISMATCH`.
   *
   * `sub` — NEVER the email, never the display name, and never anything the
   * client sent. Google itself documents `sub` as the only claim guaranteed
   * stable for an account, an email address can be re-assigned or simply not
   * verified, and a client-submitted id is not evidence of anything. This is
   * the same key `POST /auth/google` resolves accounts by, so "the identity
   * that can sign in" and "the identity that can delete" are the same value
   * by construction.
   *
   * THE COMPARISON IS AGAINST A ROW THIS ACCOUNT OWNS, loaded by `userId`
   * from the caller's own access token — not a global lookup of the token's
   * `sub` followed by an ownership test. A global lookup that then compared
   * user ids would be equivalent today and one refactor away from
   * "whichever account owns this token", which is the cross-account deletion
   * this design must make unreachable.
   */
  private async authorizeWithGoogle(
    userId: string,
    account: DeletionAccount,
    dto: AccountDeletionDto,
    context: AuthRequestContext,
  ): Promise<DeletionAuthorization> {
    const linkedSubject = account.subjects.google;

    if (linkedSubject === undefined || !this.isProviderVerifiable('google')) {
      throw await this.refuse(
        userId,
        'google',
        'method_unavailable',
        context,
        methodUnavailable('google'),
      );
    }

    let verifiedSubject: string;
    try {
      const verified = await this.googleVerifier.verifyIdToken(
        dto.idToken ?? '',
      );
      verifiedSubject = verified.subject;
    } catch (error) {
      if (error instanceof GoogleTokenRejected) {
        throw await this.refuse(
          userId,
          'google',
          'invalid_google_token',
          context,
          invalidGoogleToken(),
        );
      }
      // An `AppException` from the verifier (e.g. the disabled stub's
      // `GOOGLE_AUTH_DISABLED`) is already the right answer; anything else
      // is a genuine, unexpected failure that must keep surfacing as a 500
      // rather than being laundered into "invalid credential". Same narrow
      // catch as `AuthIdentityService.verifyGoogleToken`.
      throw error;
    }

    if (verifiedSubject !== linkedSubject) {
      throw await this.refuse(
        userId,
        'google',
        'proof_identity_mismatch',
        context,
        proofMismatch(
          'That Google account is not the one linked to this account.',
        ),
      );
    }

    return { method: 'google', userId, whatsappPhoneE164: null };
  }

  // ======================================================================
  // WHATSAPP
  // ======================================================================

  /**
   * A WhatsApp-only (or WhatsApp-linked) account deletes itself by consuming
   * a one-time code delivered to the number it already has linked — never a
   * Red Panda password it never created.
   *
   * ============ THE CHALLENGE IS BOUND TO THIS ACCOUNT BY THE NUMBER ============
   *
   * The number is read from this account's own `AuthIdentity` row, exactly
   * as `requestWhatsAppChallenge` read it when the code was sent — the
   * request body carries only the code. Because
   * `AuthIdentity @@unique([provider, providerSubject])` makes a phone number
   * resolve to AT MOST ONE account, a code delivered to that handset cannot
   * authorize deleting anybody else's account: another account's deletion
   * request would look up a DIFFERENT number and find no challenge for it.
   *
   * SINGLE-USE AND SHORT-LIVED WITHOUT A NEW MECHANISM: `claimChallenge`'s
   * `consumedAt` compare-and-set makes a code usable exactly once even under
   * concurrent submission, `expiresAt` bounds it to `OTP_TTL_MS`, and
   * `attemptCount` bounds guessing — the properties a bespoke deletion token
   * would have had to re-implement.
   *
   * AND IT CANNOT LOG ANYONE IN. The challenge lives in the
   * `account_deletion` purpose namespace; `POST /auth/whatsapp/otp/verify`
   * only ever reads the `login` namespace, so this code is invisible to it.
   */
  private async authorizeWithWhatsApp(
    userId: string,
    account: DeletionAccount,
    dto: AccountDeletionDto,
    context: AuthRequestContext,
  ): Promise<DeletionAuthorization> {
    const phoneE164 = account.subjects.whatsapp;

    if (phoneE164 === undefined || !this.isProviderVerifiable('whatsapp')) {
      throw await this.refuse(
        userId,
        'whatsapp',
        'method_unavailable',
        context,
        methodUnavailable('whatsapp'),
      );
    }

    try {
      await this.whatsAppOtpService.claimChallenge(
        phoneE164,
        'account_deletion',
        dto.code ?? '',
      );
    } catch (error) {
      if (error instanceof OtpRejected) {
        // The SPECIFIC reason (not found / expired / wrong code / attempts
        // exhausted / claim lost) is recorded server-side; the caller always
        // sees the same generic `INVALID_OTP`, matching
        // `AuthIdentityService.consumeOtp` exactly.
        throw await this.refuse(
          userId,
          'whatsapp',
          error.reason,
          context,
          invalidOtp(),
        );
      }
      throw error;
    }

    return { method: 'whatsapp', userId, whatsappPhoneE164: phoneE164 };
  }

  // ======================================================================
  // SHARED
  // ======================================================================

  /**
   * The account's deletion-relevant facts in ONE round trip: whether it has
   * a password, and which external identities it owns.
   *
   * A missing row means a concurrent `deleteAccount()` already removed the
   * account. Reported as `INVALID_ACCESS_TOKEN`/401 — the precedent
   * `AuthService.deleteAccount`, `getUserById` and
   * `AuthIdentityService.accountVanished` all already share for "this token
   * names an account that no longer exists".
   */
  private async loadAccount(userId: string): Promise<DeletionAccount> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        authIdentities: { select: { provider: true, providerSubject: true } },
      },
    });

    if (!user) {
      throw accountVanished();
    }

    const subjects: Partial<Record<AuthProvider, string>> = {};
    for (const identity of user.authIdentities) {
      subjects[identity.provider as AuthProvider] = identity.providerSubject;
    }

    return {
      passwordHash: user.passwordHash,
      providers: user.authIdentities.map((row) => row.provider as AuthProvider),
      subjects,
    };
  }

  /**
   * The `providerSubject` this account has linked for `provider`, or the
   * same `409 ACCOUNT_DELETION_METHOD_UNAVAILABLE` the deletion endpoint
   * returns. Used by `requestWhatsAppChallenge`, so asking for a deletion
   * code on an account with no linked number is refused BEFORE any message
   * is attempted.
   */
  private async requireLinkedSubject(
    userId: string,
    provider: 'google' | 'whatsapp',
  ): Promise<string> {
    const account = await this.loadAccount(userId);
    const subject = account.subjects[provider];

    if (subject === undefined || !this.isProviderVerifiable(provider)) {
      throw methodUnavailable(provider);
    }

    return subject;
  }

  /**
   * Whether this server can verify a provider proof at all right now.
   * Mirrors `AuthIdentityService.assertGoogleEnabled`/`assertWhatsAppEnabled`
   * — the same two flags, read from the same resolved config — but answers
   * with a boolean instead of throwing, because "cannot be verified" is a
   * REASON A METHOD IS UNAVAILABLE here, not a separate outcome: a
   * Google-only account on a Google-disabled server needs to hear
   * `ACCOUNT_DELETION_METHOD_UNAVAILABLE` with the full list of what it CAN
   * use, not a bare `503` about a provider it never asked about.
   */
  private isProviderVerifiable(method: DeletionProofMethod): boolean {
    const identity = this.configService.get('identityProviders', {
      infer: true,
    })!;

    switch (method) {
      case 'google':
        return identity.googleEnabled;
      case 'whatsapp':
        return identity.whatsappEnabled;
      case 'password':
        // Password verification needs no external provider and no flag; an
        // account either has a hash or it does not.
        return true;
    }
  }

  /**
   * Emits `account_deletion_failed` with the specific server-side reason and
   * returns the (generic) exception for the caller to throw.
   *
   * RETURNS rather than throws, so every refusal site reads
   * `throw await this.refuse(...)` — which makes it syntactically impossible
   * to audit a refusal and then forget to actually refuse, the failure mode
   * a `void`-returning helper invites.
   *
   * `userId` IS included, unlike `account_deletion_success`: a refusal means
   * the account still exists, so the foreign key is valid and there is
   * something to link to. Same split `change_password_failed` already uses.
   */
  private async refuse(
    userId: string,
    method: DeletionProofMethod,
    reason: string,
    context: AuthRequestContext,
    exception: AppException,
  ): Promise<AppException> {
    await this.authAuditService.emit('account_deletion_failed', {
      userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { reason, method },
    });
    return exception;
  }
}

/** What `authorize` needs to know about an account, loaded once. */
interface DeletionAccount {
  readonly passwordHash: string | null;
  readonly providers: readonly AuthProvider[];
  /** `providerSubject` per linked provider — a Google `sub`, an E.164 number. */
  readonly subjects: Partial<Record<AuthProvider, string>>;
}

function invalidCredentials(): AppException {
  return new AppException(
    AppErrorCode.INVALID_CREDENTIALS,
    'Invalid email or password',
    HttpStatus.UNAUTHORIZED,
  );
}

function invalidOtp(): AppException {
  return new AppException(
    AppErrorCode.INVALID_OTP,
    'Invalid or expired verification code',
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * The message names the discovery endpoint deliberately: a client that hits
 * this has asked for a proof the account cannot produce, and the ONE thing
 * it needs next is the list of proofs the account can.
 */
function methodUnavailable(method: DeletionProofMethod): AppException {
  return new AppException(
    AppErrorCode.ACCOUNT_DELETION_METHOD_UNAVAILABLE,
    `This account cannot confirm deletion with "${method}". Call GET /users/me/deletion/methods for the methods it can use.`,
    HttpStatus.CONFLICT,
  );
}

function proofMismatch(message: string): AppException {
  return new AppException(
    AppErrorCode.ACCOUNT_DELETION_PROOF_MISMATCH,
    message,
    HttpStatus.UNAUTHORIZED,
  );
}

function accountVanished(): AppException {
  return new AppException(
    AppErrorCode.INVALID_ACCESS_TOKEN,
    'Invalid or expired access token',
    HttpStatus.UNAUTHORIZED,
  );
}
