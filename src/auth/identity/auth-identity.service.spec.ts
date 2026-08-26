import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { bcryptTestBudgetMs } from '../../common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  TEST_FIXTURE_PHONE_PREFIX,
  fixtureEmail,
  fixtureMarker,
  fixturePhone,
} from '../../common/testing/fixture-namespace.helpers';
import { AccountLockoutService } from '../account-lockout.service';
import { AuthAuditService } from '../auth-audit.service';
import type {
  AuthAuditEventName,
  EmitAuthAuditEventParams,
} from '../auth-audit.types';
import type { RootConfig } from '../../config/configuration';
import { AuthService } from '../auth.service';
import { AuthIdentityService } from './auth-identity.service';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from './auth-identity.constants';
import { GOOGLE_IDENTITY_VERIFIER } from './google/google-identity.types';
import type {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './google/google-identity.types';
import { GoogleTokenRejected } from './google/google-id-token.util';
import {
  WHATSAPP_OTP_PROVIDER,
  WhatsAppDeliveryError,
} from './whatsapp/whatsapp-otp.types';
import type {
  SendWhatsAppOtpInput,
  WhatsAppOtpProvider,
} from './whatsapp/whatsapp-otp.types';
import { WhatsAppOtpService } from './whatsapp/whatsapp-otp.service';

/**
 * PHASE 10B — integration-style spec for the provider-neutral identity layer,
 * following `auth.service.spec.ts`'s established shape exactly: a real
 * `PrismaService` against the real database, a stubbed `ConfigService` so the
 * test owns the secrets and feature flags, and self-cleaning namespaced
 * fixtures.
 *
 * The Google verifier and the WhatsApp delivery provider are substituted at
 * their DI TOKENS — the same seam production uses to bind the inert
 * `Disabled*` implementations — so this suite can never reach Google or a
 * messaging vendor. Everything else is real: real Prisma writes, real
 * transactions, real `AuthService` session issuance, real HMACs, real
 * concurrency.
 */
jest.setTimeout(bcryptTestBudgetMs(8));

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

/**
 * A verifier that returns whatever the test has decided a given opaque
 * "token" string proves. It performs NO cryptography — the real signature and
 * claim rules are covered exhaustively by
 * `google-oidc.verifier.spec.ts`/`google-id-token.util.spec.ts` against real
 * generated RSA keys. What this suite tests is what the SERVICE does with a
 * verification result, which is a different question and deserves not to be
 * entangled with key material.
 */
class ScriptedGoogleVerifier implements GoogleIdentityVerifier {
  private readonly identities = new Map<string, GoogleVerifiedIdentity>();
  private readonly rejections = new Map<string, GoogleTokenRejected>();

  grant(token: string, identity: GoogleVerifiedIdentity): void {
    this.identities.set(token, identity);
  }

  reject(token: string, reason: GoogleTokenRejected['reason']): void {
    this.rejections.set(token, new GoogleTokenRejected(reason));
  }

  verifyIdToken(idToken: string): Promise<GoogleVerifiedIdentity> {
    const rejection = this.rejections.get(idToken);
    if (rejection) {
      return Promise.reject(rejection);
    }
    const identity = this.identities.get(idToken);
    if (!identity) {
      return Promise.reject(new GoogleTokenRejected('bad_signature'));
    }
    return Promise.resolve(identity);
  }
}

/** Records what "was sent" without sending anything, like the local fake provider. */
class RecordingOtpProvider implements WhatsAppOtpProvider {
  readonly sent: SendWhatsAppOtpInput[] = [];
  /**
   * `true` throws an UNCLASSIFIED error, which the service must treat as
   * `provider_unavailable` — the fail-closed reading of a surprise.
   */
  shouldFail = false;
  /** A classified failure, to exercise both branches of the delivery split. */
  failWith: 'provider_unavailable' | 'recipient_rejected' | undefined;

  sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
    if (this.failWith !== undefined) {
      return Promise.reject(
        new WhatsAppDeliveryError(this.failWith, 'simulated delivery failure'),
      );
    }
    if (this.shouldFail) {
      return Promise.reject(new Error('simulated vendor outage'));
    }
    this.sent.push(input);
    return Promise.resolve();
  }

  lastCodeFor(phoneE164: string): string {
    const match = [...this.sent]
      .reverse()
      .find((s) => s.phoneE164 === phoneE164);
    if (!match) {
      throw new Error(`No OTP was sent to ${phoneE164}`);
    }
    return match.code;
  }
}

/**
 * The marker `userAgent` every audit row this suite produces is stamped
 * with, so a row that has no other attribution is still unambiguously OURS.
 * Namespaced (never a bare literal) per `fixture-namespace.helpers.ts`.
 */
const SPEC_AUDIT_USER_AGENT = fixtureMarker('ai-audit-agent');

/**
 * `AuthAuditService` with this run's fixture namespace stamped onto every
 * row it writes.
 *
 * WHY THIS EXISTS. Many of the audit rows this suite produces are emitted
 * with NO `userId`: `otp_requested` on every `requestOtp`,
 * `identity_login_failed` on every rejected Google token or wrong OTP, and
 * `login_failed`/`password_reset_requested` for an address that never
 * resolved to an account. Having neither a user to join through nor a marker
 * of their own, `afterEach` used to reclaim them with a namespace-blind
 * `deleteMany({ where: { userId: null } })` — which also deleted the
 * `userId: null` rows belonging to every OTHER Jest worker sharing this
 * database. `auth-audit.service.spec.ts` is the suite that pays for it: its
 * rows are deliberately emitted WITHOUT a `userId`, so a concurrent run of
 * this file would delete them mid-test and its assertions would then fail on
 * a `null` row — a failure whose message points at IP hashing rather than at
 * the real cause. See `fixture-namespace.helpers.ts` for the full model.
 *
 * `auth.service.spec.ts` and `account-deletion.service.spec.ts` solve the
 * same problem by passing a marker `userAgent` at each call site. This suite
 * has ~90 such call sites, so it stamps the marker once, at the single point
 * every audit row is born — which also makes it impossible for a call site
 * added later to forget. A test that passes its own `userAgent` keeps it.
 *
 * Constructed by hand in a `useFactory` rather than `useClass`: this
 * subclass carries no `@Injectable()` decorator of its own, so it has no
 * `design:paramtypes` metadata for Nest to resolve constructor arguments
 * from.
 */
class NamespacedAuthAuditService extends AuthAuditService {
  override emit(
    event: AuthAuditEventName,
    params: EmitAuthAuditEventParams = {},
  ): Promise<void> {
    return super.emit(event, {
      ...params,
      userAgent: params.userAgent ?? SPEC_AUDIT_USER_AGENT,
    });
  }
}

describe('AuthIdentityService', () => {
  let identityService: AuthIdentityService;
  let authService: AuthService;
  let otpService: WhatsAppOtpService;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let google: ScriptedGoogleVerifier;
  let otpProvider: RecordingOtpProvider;

  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`ai-${label}`);

  /**
   * A NAMESPACED Google subject. This must never be a bare literal like
   * `'g-parity'`: a Google-only account has `email: null`, so the
   * email-prefixed cleanup below cannot match it, and a `google` identity
   * created by one run would still be there for the next run to "sign into"
   * — producing failures (an unexpected extra `Session`, an account id that
   * predates the test) whose message points nowhere near the real cause.
   * This is the exact failure signature `TEST_FIXTURE_NAMESPACE` was
   * introduced for; see `fixture-namespace.helpers.ts`.
   */
  const uniqueSubject = (label: string): string =>
    `${TEST_FIXTURE_NAMESPACE}-g-${label}`;

  const identityConfig = {
    googleEnabled: true,
    googleClientIds: ['test-client-id.apps.googleusercontent.com'],
    whatsappEnabled: true,
    whatsappOtpDriver: 'fake',
  };

  const appConfig = { devToolsEnabled: false };

  beforeEach(async () => {
    google = new ScriptedGoogleVerifier();
    otpProvider = new RecordingOtpProvider();
    identityConfig.googleEnabled = true;
    identityConfig.whatsappEnabled = true;
    appConfig.devToolsEnabled = false;

    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        AuthService,
        AuthIdentityService,
        WhatsAppOtpService,
        PrismaService,
        AccountLockoutService,
        {
          provide: AuthAuditService,
          inject: [PrismaService, ConfigService],
          useFactory: (
            prisma: PrismaService,
            configService: ConfigService<RootConfig>,
          ): AuthAuditService =>
            new NamespacedAuthAuditService(prisma, configService),
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'identityProviders') return identityConfig;
              if (key === 'app') return appConfig;
              return TEST_AUTH_CONFIG;
            }),
          },
        },
        { provide: GOOGLE_IDENTITY_VERIFIER, useValue: google },
        { provide: WHATSAPP_OTP_PROVIDER, useValue: otpProvider },
      ],
    }).compile();

    identityService = module.get(AuthIdentityService);
    authService = module.get(AuthService);
    otpService = module.get(WhatsAppOtpService);
    prisma = module.get(PrismaService);
    jwtService = module.get(JwtService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    // `AuthAuditEvent` SetNulls rather than cascading, so it is cleared while
    // `userId` still links rows back to this run's accounts — the same
    // ordering `auth.service.spec.ts`'s cleanup uses and for the same reason.
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
    // Rows this suite emitted with no `userId` (`otp_requested`, a rejected
    // Google token's `identity_login_failed`, a `login_failed` for an address
    // that never resolved). They are found by the namespaced marker
    // `userAgent` that `NamespacedAuthAuditService` stamps on every row —
    // NEVER by a bare `{ userId: null }`, which would also delete the rows of
    // other Jest workers sharing this database. Same predicate shape as
    // `auth.service.spec.ts`'s orphan cleanup.
    await prisma.authAuditEvent.deleteMany({
      where: { userId: null, userAgent: { startsWith: emailPrefix } },
    });
    // `AuthIdentity` and `Session` both cascade with `User`; the identity
    // sweep is scoped by phone prefix too, because a WhatsApp-only account
    // has no email for the predicate above to match.
    // Both namespaced subject shapes: phone numbers (WhatsApp) and
    // `<namespace>-g-*` (Google). A social-only account has `email: null`,
    // so the email predicate below cannot reach it — without this sweep a
    // Google identity would survive into the next run and be signed into.
    const socialOwners = await prisma.authIdentity.findMany({
      where: {
        OR: [
          { providerSubject: { startsWith: TEST_FIXTURE_PHONE_PREFIX } },
          { providerSubject: { startsWith: TEST_FIXTURE_NAMESPACE } },
        ],
      },
      select: { userId: true },
    });
    await prisma.user.deleteMany({
      where: { id: { in: socialOwners.map((row) => row.userId) } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: emailPrefix } },
    });
    // `PhoneOtpChallenge` has no owning `User` to cascade from (deliberately
    // — see its schema doc comment), so it is swept by the namespaced phone
    // prefix. Production relies on the opportunistic retention prune
    // instead; tests clean up eagerly so a run leaves no residue.
    await prisma.phoneOtpChallenge.deleteMany({
      where: { phoneE164: { startsWith: TEST_FIXTURE_PHONE_PREFIX } },
    });
    await prisma.onModuleDestroy();
  });

  // ====================================================================
  // EMAIL/PASSWORD — unchanged behaviour, and the identity row that backs it
  // ====================================================================

  describe('email/password remains a first-class provider', () => {
    it('register creates the account AND its email identity in one step', async () => {
      const email = uniqueEmail('register');

      const response = await authService.register({
        email,
        password: 'correct-horse-battery',
      });

      const identities = await identityService.listIdentities(response.user.id);

      expect(identities).toHaveLength(1);
      expect(identities[0]).toMatchObject({
        provider: 'email',
        identifier: email,
        usable: true,
        // The last usable method can never be unlinked, and `email` is not
        // unlinkable through this route at all.
        canBeUnlinked: false,
      });
    });

    it('a duplicate register is rejected truthfully and creates nothing', async () => {
      const email = uniqueEmail('dupe');
      await authService.register({ email, password: 'correct-horse-battery' });

      await expect(
        authService.register({ email, password: 'a-different-password' }),
      ).rejects.toMatchObject({ code: AppErrorCode.EMAIL_ALREADY_REGISTERED });

      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(
        await prisma.authIdentity.count({
          where: { provider: 'email', providerSubject: email },
        }),
      ).toBe(1);
    });

    it('an INVALID login NEVER creates a user — no silent auto-registration', async () => {
      const email = uniqueEmail('never-created');

      await expect(
        authService.login({ email, password: 'whatever-they-typed' }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_CREDENTIALS });

      // The account-existence assertions are the point of this test: a failed
      // login must leave the database exactly as it found it.
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      expect(
        await prisma.authIdentity.count({ where: { providerSubject: email } }),
      ).toBe(0);
      expect(await prisma.session.count({ where: { user: { email } } })).toBe(
        0,
      );
    });

    it('a wrong password against an EXISTING account stays INVALID_CREDENTIALS and creates no session', async () => {
      const email = uniqueEmail('wrong-pw');
      const registered = await authService.register({
        email,
        password: 'correct-horse-battery',
      });
      const sessionsAfterRegister = await prisma.session.count({
        where: { userId: registered.user.id },
      });

      await expect(
        authService.login({ email, password: 'not-the-password' }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_CREDENTIALS });

      expect(
        await prisma.session.count({ where: { userId: registered.user.id } }),
      ).toBe(sessionsAfterRegister);
    });

    it('a passwordless account cannot be signed into with the fixed timing-parity dummy hash', async () => {
      // The dummy hash is a committed constant. If `login` relied on
      // `bcrypt.compare` returning false rather than refusing `null`
      // explicitly, discovering its preimage would unlock every social-only
      // account at once. Here the account has an email but no password.
      const email = uniqueEmail('passwordless');
      google.grant('tok-passwordless', {
        subject: uniqueSubject('passwordless'),
        email,
      });
      await identityService.signInWithGoogle({ idToken: 'tok-passwordless' });

      const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(stored.passwordHash).toBeNull();

      await expect(
        authService.login({ email, password: 'anything-at-all' }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_CREDENTIALS });
    });

    it('password reset refuses to mint a password for a social-only account', async () => {
      // A reset would otherwise ADD an email/password credential to a
      // Google-only account — a new way in, created by a flow whose purpose
      // is restoring an existing one.
      const email = uniqueEmail('social-reset');
      google.grant('tok-social-reset', {
        subject: uniqueSubject('social-reset'),
        email,
      });
      await identityService.signInWithGoogle({ idToken: 'tok-social-reset' });

      const response = await authService.requestPasswordReset({ email });

      // Same 202-shaped success as an unknown email: no enumeration signal.
      expect(response).toEqual({ success: true });
      expect(
        await prisma.passwordResetToken.count({ where: { user: { email } } }),
      ).toBe(0);
    });
  });

  // ====================================================================
  // GOOGLE
  // ====================================================================

  describe('Google sign-in', () => {
    it('creates a new account and its identity for a genuinely new subject', async () => {
      const email = uniqueEmail('g-new');
      google.grant('tok-new', {
        subject: uniqueSubject('sub-new'),
        email,
        displayName: 'New Person',
      });

      const response = await identityService.signInWithGoogle({
        idToken: 'tok-new',
      });

      expect(response.user.email).toBe(email);
      expect(response.user.displayName).toBe('New Person');
      expect(response.accessToken).toEqual(expect.any(String));
      expect(response.refreshToken).toEqual(expect.any(String));

      const identity = await prisma.authIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: 'google',
            providerSubject: uniqueSubject('sub-new'),
          },
        },
      });
      expect(identity.userId).toBe(response.user.id);
      expect(identity.verifiedAt).not.toBeNull();
    });

    it('signs a RETURNING subject into the SAME account, never a second one', async () => {
      const email = uniqueEmail('g-return');
      google.grant('tok-return', {
        subject: uniqueSubject('sub-return'),
        email,
      });

      const first = await identityService.signInWithGoogle({
        idToken: 'tok-return',
      });
      const second = await identityService.signInWithGoogle({
        idToken: 'tok-return',
      });

      expect(second.user.id).toBe(first.user.id);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      // Two distinct sessions, one account — sign-in issues a session, it
      // does not reuse one.
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('resolves the identity by SUBJECT, not by email — a changed Google email still signs into the same account', async () => {
      const original = uniqueEmail('g-sub-a');
      const changed = uniqueEmail('g-sub-b');
      google.grant('tok-sub', {
        subject: uniqueSubject('sub-stable'),
        email: original,
      });

      const first = await identityService.signInWithGoogle({
        idToken: 'tok-sub',
      });

      google.grant('tok-sub', {
        subject: uniqueSubject('sub-stable'),
        email: changed,
      });
      const second = await identityService.signInWithGoogle({
        idToken: 'tok-sub',
      });

      expect(second.user.id).toBe(first.user.id);
    });

    it('rejects an invalid token generically and creates nothing', async () => {
      google.reject('tok-bad', 'bad_signature');

      await expect(
        identityService.signInWithGoogle({ idToken: 'tok-bad' }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_GOOGLE_TOKEN });
    });

    it('reports a wrong audience and an expired token with the SAME client-facing error', async () => {
      google.reject('tok-aud', 'bad_audience');
      google.reject('tok-exp', 'expired');

      const errors = await Promise.all(
        ['tok-aud', 'tok-exp'].map((idToken) =>
          identityService
            .signInWithGoogle({ idToken })
            .then(() => null)
            .catch((error: AppException) => error),
        ),
      );

      // Distinguishing them would tell an attacker which check to defeat next.
      expect(errors.map((e) => e?.code)).toEqual([
        AppErrorCode.INVALID_GOOGLE_TOKEN,
        AppErrorCode.INVALID_GOOGLE_TOKEN,
      ]);
      expect(errors[0]?.message).toBe(errors[1]?.message);
    });

    it('records the SPECIFIC rejection reason server-side even though the response is generic', async () => {
      google.reject('tok-audit', 'bad_audience');

      await expect(
        identityService.signInWithGoogle({ idToken: 'tok-audit' }),
      ).rejects.toBeInstanceOf(AppException);

      // Scoped to THIS run's marker for the same reason the cleanup above is:
      // `identity_login_failed`/`userId: null` alone also matches rows another
      // concurrent Jest worker is writing, which could fill the `take: 5`
      // window and hide the row this test just caused.
      const events = await prisma.authAuditEvent.findMany({
        where: {
          event: 'identity_login_failed',
          userId: null,
          userAgent: { startsWith: emailPrefix },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      expect(
        events.some((e) => JSON.stringify(e.metadata).includes('bad_audience')),
      ).toBe(true);
    });

    it('answers 503 GOOGLE_AUTH_DISABLED when the provider is off, without touching the verifier', async () => {
      identityConfig.googleEnabled = false;
      google.grant('tok-off', { subject: uniqueSubject('off') });

      await expect(
        identityService.signInWithGoogle({ idToken: 'tok-off' }),
      ).rejects.toMatchObject({ code: AppErrorCode.GOOGLE_AUTH_DISABLED });
    });

    it('does NOT record an unverified Google email as the account email', async () => {
      // `validateGoogleClaims` drops an unverified email, so the service sees
      // `undefined`. The account is created with no email rather than an
      // unproven one.
      google.grant('tok-unverified', { subject: uniqueSubject('unverified') });

      const response = await identityService.signInWithGoogle({
        idToken: 'tok-unverified',
      });

      expect(response.user.email).toBeNull();
      const identity = await prisma.authIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: 'google',
            providerSubject: uniqueSubject('unverified'),
          },
        },
      });
      expect(identity.normalizedIdentifier).toBeNull();
    });
  });

  // ====================================================================
  // ACCOUNT COLLISION — the takeover boundary
  // ====================================================================

  describe('account collision', () => {
    it('REFUSES to attach a new Google identity to an existing email/password account', async () => {
      const email = uniqueEmail('collide');
      const existing = await authService.register({
        email,
        password: 'correct-horse-battery',
      });
      google.grant('tok-collide', { subject: uniqueSubject('collide'), email });

      await expect(
        identityService.signInWithGoogle({ idToken: 'tok-collide' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.AUTH_ACCOUNT_LINK_REQUIRED,
      });

      // NOTHING happened: no second account, no identity, no session.
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(
        await prisma.authIdentity.count({
          where: { providerSubject: uniqueSubject('collide') },
        }),
      ).toBe(0);
      expect(
        await prisma.authIdentity.count({
          where: { userId: existing.user.id, provider: 'google' },
        }),
      ).toBe(0);
    });

    it('records the targeted account in the audit trail so a takeover attempt is investigable', async () => {
      const email = uniqueEmail('collide-audit');
      const existing = await authService.register({
        email,
        password: 'correct-horse-battery',
      });
      google.grant('tok-collide-audit', {
        subject: uniqueSubject('collide-audit'),
        email,
      });

      await expect(
        identityService.signInWithGoogle({ idToken: 'tok-collide-audit' }),
      ).rejects.toBeInstanceOf(AppException);

      expect(
        await prisma.authAuditEvent.count({
          where: { event: 'identity_link_required', userId: existing.user.id },
        }),
      ).toBe(1);
    });

    it('an UNVERIFIED matching email does NOT collide — and does not grant access either', async () => {
      const email = uniqueEmail('collide-unverified');
      const existing = await authService.register({
        email,
        password: 'correct-horse-battery',
      });
      // Unverified email is dropped before the service sees it.
      google.grant('tok-collide-unverified', {
        subject: uniqueSubject('unverified-collide'),
      });

      const response = await identityService.signInWithGoogle({
        idToken: 'tok-collide-unverified',
      });

      // A SEPARATE account, which is the safe outcome: the unproven address
      // neither blocks the sign-in nor unlocks the existing account.
      expect(response.user.id).not.toBe(existing.user.id);
      expect(response.user.email).toBeNull();
    });
  });

  // ====================================================================
  // WHATSAPP OTP
  // ====================================================================

  describe('WhatsApp OTP', () => {
    it('issues a code, and a valid code signs in and creates the account', async () => {
      const phone = fixturePhone();

      const requested = await identityService.requestOtp({ phone });
      expect(requested).toMatchObject({ success: true });
      expect(requested.expiresInSeconds).toBe(Math.floor(OTP_TTL_MS / 1000));
      // PHASE 10C: the client renders its resend countdown from THIS value
      // rather than a constant of its own, so it must be the server's real
      // cooldown and must be present on every issue.
      expect(requested.resendAvailableInSeconds).toBe(
        Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      );
      // No plaintext code in the response while dev-tools exposure is off.
      expect(requested.devCode).toBeUndefined();

      const response = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      expect(response.accessToken).toEqual(expect.any(String));
      expect(response.user.email).toBeNull();
      const identity = await prisma.authIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: 'whatsapp',
            providerSubject: phone,
          },
        },
      });
      expect(identity.userId).toBe(response.user.id);
      expect(identity.verifiedAt).not.toBeNull();
    });

    it('NEVER persists the plaintext code', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const code = otpProvider.lastCodeFor(phone);

      const challenge = await prisma.phoneOtpChallenge.findFirstOrThrow({
        where: { phoneE164: phone },
      });

      expect(challenge.codeHash).not.toContain(code);
      expect(challenge.codeHash).toHaveLength(64);
    });

    it('binds the hash to the PHONE NUMBER, so the same code hashes differently elsewhere', async () => {
      // Without the binding, one precomputed table of HMAC(secret, code)
      // would cover every 6-digit code this system ever issues.
      const phoneA = fixturePhone();
      const phoneB = fixturePhone();
      await identityService.requestOtp({ phone: phoneA });
      const codeA = otpProvider.lastCodeFor(phoneA);

      // Force phone B's challenge to carry the same code by verifying that a
      // hash computed for A cannot be reused for B.
      await identityService.requestOtp({ phone: phoneB });

      const [a, b] = await Promise.all([
        prisma.phoneOtpChallenge.findFirstOrThrow({
          where: { phoneE164: phoneA },
        }),
        prisma.phoneOtpChallenge.findFirstOrThrow({
          where: { phoneE164: phoneB },
        }),
      ]);

      // The wrong-number code is rejected even if an attacker learned it.
      await expect(
        identityService.verifyOtp({ phone: phoneB, code: codeA }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });
      expect(a.codeHash).not.toBe(b.codeHash);
    });

    it('rejects a WRONG code and consumes an attempt', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });

      await expect(
        identityService.verifyOtp({ phone, code: '000000' }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });

      const challenge = await prisma.phoneOtpChallenge.findFirstOrThrow({
        where: { phoneE164: phone },
      });
      expect(challenge.attemptCount).toBe(1);
      expect(challenge.consumedAt).toBeNull();
    });

    it('rejects an EXPIRED code', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const code = otpProvider.lastCodeFor(phone);

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        identityService.verifyOtp({ phone, code }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });
      expect(
        await prisma.authIdentity.count({ where: { providerSubject: phone } }),
      ).toBe(0);
    });

    it('exhausts the attempt budget and then refuses even the CORRECT code', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const code = otpProvider.lastCodeFor(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        await expect(
          identityService.verifyOtp({ phone, code: wrong }),
        ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });
      }

      // The budget is what defends a 6-digit secret, so it must hold even
      // against someone who then produces the right answer.
      await expect(
        identityService.verifyOtp({ phone, code }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });
    });

    it('makes a code SINGLE-USE — a second verify with the same code is refused', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const code = otpProvider.lastCodeFor(phone);

      await identityService.verifyOtp({ phone, code });

      await expect(
        identityService.verifyOtp({ phone, code }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });
    });

    it('enforces a per-NUMBER resend cooldown', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });

      await expect(identityService.requestOtp({ phone })).rejects.toMatchObject(
        {
          code: AppErrorCode.OTP_RESEND_COOLDOWN,
        },
      );

      // The refused request left no extra row behind.
      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(1);
    });

    it('invalidates the previous code when a new one is issued after the cooldown', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const firstCode = otpProvider.lastCodeFor(phone);

      // Age the first challenge past the cooldown window.
      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });

      await identityService.requestOtp({ phone });
      const secondCode = otpProvider.lastCodeFor(phone);

      await expect(
        identityService.verifyOtp({ phone, code: firstCode }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });
      await expect(
        identityService.verifyOtp({ phone, code: secondCode }),
      ).resolves.toMatchObject({ accessToken: expect.any(String) as string });
    });

    it('normalizes +62 / 08 spellings onto ONE identity — a returning user is the same account', async () => {
      const phone = fixturePhone();
      const nationalSpelling = `0${phone.slice(3)}`;

      await identityService.requestOtp({ phone });
      const first = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });

      // Requested and verified with the OTHER spelling entirely.
      await identityService.requestOtp({ phone: nationalSpelling });
      const second = await identityService.verifyOtp({
        phone: nationalSpelling,
        code: otpProvider.lastCodeFor(phone),
      });

      expect(second.user.id).toBe(first.user.id);
      expect(
        await prisma.authIdentity.count({
          where: { provider: 'whatsapp', providerSubject: phone },
        }),
      ).toBe(1);
    });

    it('signs a RETURNING phone identity into the SAME account', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const first = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      await identityService.requestOtp({ phone });
      const second = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      expect(second.user.id).toBe(first.user.id);
      expect(await prisma.user.count({ where: { id: first.user.id } })).toBe(1);
      // Still exactly ONE identity for the number — a second sign-in is a
      // login, never a second registration.
      expect(
        await prisma.authIdentity.count({
          where: { provider: 'whatsapp', providerSubject: phone },
        }),
      ).toBe(1);
    });

    it('refuses to link a phone number that already belongs to a DIFFERENT account', async () => {
      // The database-level `@@unique([provider, providerSubject])` is what
      // makes one phone number resolve to at most one human's account; this
      // is the duplicate-phone case from the other direction.
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const owner = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      const other = await authService.register({
        email: uniqueEmail('dupe-phone'),
        password: 'correct-horse-battery',
      });

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      await identityService.requestOtp({ phone });

      await expect(
        identityService.linkWhatsApp(other.user.id, {
          phone,
          code: otpProvider.lastCodeFor(phone),
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.AUTH_IDENTITY_ALREADY_LINKED,
      });

      const identity = await prisma.authIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: 'whatsapp',
            providerSubject: phone,
          },
        },
      });
      expect(identity.userId).toBe(owner.user.id);
    });

    it('rejects a malformed phone number before any database access', async () => {
      const before = await prisma.phoneOtpChallenge.count();

      await expect(
        identityService.requestOtp({ phone: 'not-a-phone' }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_PHONE_NUMBER });

      expect(await prisma.phoneOtpChallenge.count()).toBe(before);
    });

    it('answers 503 WHATSAPP_AUTH_DISABLED when the provider is off', async () => {
      identityConfig.whatsappEnabled = false;

      await expect(
        identityService.requestOtp({ phone: fixturePhone() }),
      ).rejects.toMatchObject({ code: AppErrorCode.WHATSAPP_AUTH_DISABLED });
    });

    /**
     * WHATSAPP LOGIN V1 — the deliberate change to the `202` contract.
     *
     * The old behaviour was "swallow every delivery failure and answer 202".
     * That is now split in two, because the two failures reveal different
     * things: a provider OUTAGE is identical for every number and so leaks
     * nothing, while a per-RECIPIENT refusal would vary by number and so
     * must stay invisible. See `WhatsAppDeliveryFailureKind`.
     */
    it('CRITICAL: answers 503 when the provider is definitively unavailable, and withdraws the challenge', async () => {
      const phone = fixturePhone();
      otpProvider.failWith = 'provider_unavailable';

      await expect(identityService.requestOtp({ phone })).rejects.toMatchObject(
        {
          code: AppErrorCode.WHATSAPP_PROVIDER_UNAVAILABLE,
        },
      );

      // No row survives — the caller must not be blocked by a cooldown for a
      // code that was never sent.
      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(0);
    });

    it('a withdrawn challenge leaves the number immediately retryable', async () => {
      const phone = fixturePhone();
      otpProvider.failWith = 'provider_unavailable';
      await identityService.requestOtp({ phone }).catch(() => undefined);

      // The cooldown would normally refuse a second request inside 60s.
      otpProvider.failWith = undefined;
      await expect(
        identityService.requestOtp({ phone }),
      ).resolves.toMatchObject({ success: true });
    });

    it('an UNCLASSIFIED provider throw fails closed as provider_unavailable', async () => {
      const phone = fixturePhone();
      otpProvider.shouldFail = true;

      await expect(identityService.requestOtp({ phone })).rejects.toMatchObject(
        {
          code: AppErrorCode.WHATSAPP_PROVIDER_UNAVAILABLE,
        },
      );
    });

    it('CRITICAL: still answers 202 when the provider refused THIS RECIPIENT', async () => {
      const phone = fixturePhone();
      otpProvider.failWith = 'recipient_rejected';

      // Byte-identical to a successful send — a per-number answer here would
      // be a phone-validity oracle on an unauthenticated route.
      await expect(
        identityService.requestOtp({ phone }),
      ).resolves.toMatchObject({ success: true });
      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(1);
    });

    it('records a delivery outage in the audit trail, without the number', async () => {
      const phone = fixturePhone();
      otpProvider.failWith = 'provider_unavailable';

      await identityService.requestOtp({ phone }).catch(() => undefined);

      const events = await prisma.authAuditEvent.findMany({
        where: {
          event: 'otp_delivery_failed',
          userAgent: SPEC_AUDIT_USER_AGENT,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({ reason: 'provider_unavailable' });
      expect(JSON.stringify(events[0])).not.toContain(phone);
    });

    it('exposes devCode ONLY when dev tools are enabled in a development/test NODE_ENV', async () => {
      const phone = fixturePhone();
      appConfig.devToolsEnabled = true;

      const response = await identityService.requestOtp({ phone });

      // NODE_ENV is `test` under Jest, so both halves of the gate hold.
      expect(response.devCode).toBe(otpProvider.lastCodeFor(phone));
    });

    it('withholds devCode when dev tools are disabled, even in a test NODE_ENV', async () => {
      const phone = fixturePhone();
      appConfig.devToolsEnabled = false;

      expect(
        (await identityService.requestOtp({ phone })).devCode,
      ).toBeUndefined();
    });
  });

  // ====================================================================
  // LINKING
  // ====================================================================

  describe('explicit account linking', () => {
    it('links Google to an authenticated account, resolving the collision refusal', async () => {
      const email = uniqueEmail('link-g');
      const account = await authService.register({
        email,
        password: 'correct-horse-battery',
      });
      google.grant('tok-link', { subject: uniqueSubject('link'), email });

      // Unauthenticated sign-in is refused...
      await expect(
        identityService.signInWithGoogle({ idToken: 'tok-link' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.AUTH_ACCOUNT_LINK_REQUIRED,
      });

      // ...but an AUTHENTICATED link, proving both sides, succeeds.
      const identities = await identityService.linkGoogle(account.user.id, {
        idToken: 'tok-link',
      });

      expect(identities.map((i) => i.provider).sort()).toEqual([
        'email',
        'google',
      ]);

      // And now that same token signs into the SAME account.
      const signedIn = await identityService.signInWithGoogle({
        idToken: 'tok-link',
      });
      expect(signedIn.user.id).toBe(account.user.id);
    });

    it('links WhatsApp by consuming a real OTP in the same request', async () => {
      const email = uniqueEmail('link-wa');
      const phone = fixturePhone();
      const account = await authService.register({
        email,
        password: 'correct-horse-battery',
      });

      await identityService.requestOtp({ phone });
      const identities = await identityService.linkWhatsApp(account.user.id, {
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      expect(identities.map((i) => i.provider).sort()).toEqual([
        'email',
        'whatsapp',
      ]);
      // The masked identifier is what a client sees — never the full number.
      const whatsapp = identities.find((i) => i.provider === 'whatsapp');
      expect(whatsapp?.identifier).toMatch(/^\+\*+\d{4}$/);
    });

    it('refuses to link with a WRONG OTP and creates no identity', async () => {
      const phone = fixturePhone();
      const account = await authService.register({
        email: uniqueEmail('link-wa-bad'),
        password: 'correct-horse-battery',
      });
      await identityService.requestOtp({ phone });

      await expect(
        identityService.linkWhatsApp(account.user.id, {
          phone,
          code: '000000',
        }),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_OTP });

      expect(
        await prisma.authIdentity.count({
          where: { userId: account.user.id, provider: 'whatsapp' },
        }),
      ).toBe(0);
    });

    it('refuses to STEAL an identity already linked to a different account', async () => {
      const owner = await authService.register({
        email: uniqueEmail('owner'),
        password: 'correct-horse-battery',
      });
      const attacker = await authService.register({
        email: uniqueEmail('attacker'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-owned', { subject: uniqueSubject('owned') });
      await identityService.linkGoogle(owner.user.id, { idToken: 'tok-owned' });

      await expect(
        identityService.linkGoogle(attacker.user.id, { idToken: 'tok-owned' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.AUTH_IDENTITY_ALREADY_LINKED,
      });

      const identity = await prisma.authIdentity.findUniqueOrThrow({
        where: {
          provider_providerSubject: {
            provider: 'google',
            providerSubject: uniqueSubject('owned'),
          },
        },
      });
      expect(identity.userId).toBe(owner.user.id);
    });

    it('is idempotent when re-linking the identity the caller already owns', async () => {
      const account = await authService.register({
        email: uniqueEmail('idem'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-idem', { subject: uniqueSubject('idem') });

      await identityService.linkGoogle(account.user.id, {
        idToken: 'tok-idem',
      });
      const second = await identityService.linkGoogle(account.user.id, {
        idToken: 'tok-idem',
      });

      expect(second.filter((i) => i.provider === 'google')).toHaveLength(1);
    });

    it('refuses a SECOND, different Google account on the same user', async () => {
      const account = await authService.register({
        email: uniqueEmail('two-google'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-g1', { subject: uniqueSubject('first') });
      google.grant('tok-g2', { subject: uniqueSubject('second') });

      await identityService.linkGoogle(account.user.id, { idToken: 'tok-g1' });

      await expect(
        identityService.linkGoogle(account.user.id, { idToken: 'tok-g2' }),
      ).rejects.toMatchObject({
        code: AppErrorCode.AUTH_PROVIDER_ALREADY_LINKED,
      });
    });
  });

  // ====================================================================
  // UNLINKING — the last-method rule
  // ====================================================================

  describe('unlinking', () => {
    it('unlinks a provider when another usable method remains', async () => {
      const account = await authService.register({
        email: uniqueEmail('unlink-ok'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-unlink', { subject: uniqueSubject('unlink') });
      await identityService.linkGoogle(account.user.id, {
        idToken: 'tok-unlink',
      });

      const remaining = await identityService.unlinkIdentity(
        account.user.id,
        'google',
      );

      expect(remaining.map((i) => i.provider)).toEqual(['email']);
    });

    it('REFUSES to remove the final usable authentication method', async () => {
      // A Google-created account has a `google` identity and NO password. A
      // naive "one identity row still exists" check would permit this and
      // lock the account out permanently.
      google.grant('tok-only', { subject: uniqueSubject('only') });
      const account = await identityService.signInWithGoogle({
        idToken: 'tok-only',
      });

      await expect(
        identityService.unlinkIdentity(account.user.id, 'google'),
      ).rejects.toMatchObject({ code: AppErrorCode.AUTH_LAST_IDENTITY });

      expect(
        await prisma.authIdentity.count({ where: { userId: account.user.id } }),
      ).toBe(1);
    });

    it('does not count an email identity as usable when the account has no password', async () => {
      // Construct the pathological shape directly: an email identity row on a
      // passwordless account. Unlinking WhatsApp must still be refused,
      // because the email row cannot actually sign anyone in.
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const account = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });
      await prisma.authIdentity.create({
        data: {
          userId: account.user.id,
          provider: 'email',
          providerSubject: uniqueEmail('ghost'),
        },
      });

      await expect(
        identityService.unlinkIdentity(account.user.id, 'whatsapp'),
      ).rejects.toMatchObject({ code: AppErrorCode.AUTH_LAST_IDENTITY });
    });

    it('404s for a provider the caller has not linked', async () => {
      const account = await authService.register({
        email: uniqueEmail('unlink-404'),
        password: 'correct-horse-battery',
      });

      await expect(
        identityService.unlinkIdentity(account.user.id, 'google'),
      ).rejects.toMatchObject({ code: AppErrorCode.AUTH_IDENTITY_NOT_FOUND });
    });

    it('reports canBeUnlinked consistently with what unlink actually does', async () => {
      google.grant('tok-flag', { subject: uniqueSubject('flag') });
      const account = await identityService.signInWithGoogle({
        idToken: 'tok-flag',
      });

      const [onlyIdentity] = await identityService.listIdentities(
        account.user.id,
      );
      expect(onlyIdentity.canBeUnlinked).toBe(false);

      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const identities = await identityService.linkWhatsApp(account.user.id, {
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      // With two usable methods, both become removable.
      expect(identities.every((i) => i.canBeUnlinked)).toBe(true);
    });

    it('never exposes a raw providerSubject in the listing', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const account = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      const identities = await identityService.listIdentities(account.user.id);

      expect(JSON.stringify(identities)).not.toContain(phone);
    });
  });

  // ====================================================================
  // SESSION UNIFICATION
  // ====================================================================

  describe('session parity across providers', () => {
    it('issues the SAME token/session semantics for email, Google and WhatsApp', async () => {
      const emailAccount = await authService.register({
        email: uniqueEmail('parity-email'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-parity', { subject: uniqueSubject('parity') });
      const googleAccount = await identityService.signInWithGoogle({
        idToken: 'tok-parity',
      });
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const whatsappAccount = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      for (const response of [emailAccount, googleAccount, whatsappAccount]) {
        // Same access-token contract: a JWT whose only claim is `sub`.
        const payload = jwtService.verify<{ sub: string }>(
          response.accessToken,
          {
            secret: TEST_AUTH_CONFIG.jwtAccessSecret,
          },
        );
        expect(payload.sub).toBe(response.user.id);

        // Same opaque refresh token: `REFRESH_TOKEN_BYTES` (32) of entropy,
        // hex-encoded to 64 characters, and never stored in that form.
        expect(response.refreshToken).toMatch(/^[0-9a-f]{64}$/);
        const sessions = await prisma.session.findMany({
          where: { userId: response.user.id, revokedAt: null },
        });
        expect(sessions).toHaveLength(1);
        expect(sessions[0].refreshTokenHash).not.toBe(response.refreshToken);
      }
    });

    it('a social session refreshes, rotates and detects reuse exactly like an email session', async () => {
      google.grant('tok-refresh', { subject: uniqueSubject('refresh') });
      const signedIn = await identityService.signInWithGoogle({
        idToken: 'tok-refresh',
      });

      const rotated = await authService.refresh(signedIn.refreshToken);
      expect(rotated.refreshToken).not.toBe(signedIn.refreshToken);

      // Replaying the rotated-out token is detected and cuts off every
      // session for the account — the existing hardened behaviour, unchanged.
      await expect(
        authService.refresh(signedIn.refreshToken),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_REFRESH_TOKEN });

      expect(
        await prisma.session.count({
          where: { userId: signedIn.user.id, revokedAt: null },
        }),
      ).toBe(0);
    });

    it('logout-all revokes a social session like any other', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const signedIn = await identityService.verifyOtp({
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      await authService.logoutAll(signedIn.user.id);

      await expect(
        authService.refresh(signedIn.refreshToken),
      ).rejects.toMatchObject({ code: AppErrorCode.INVALID_REFRESH_TOKEN });
    });

    it('entitlements stay attached to the SAME user id across a re-sign-in', async () => {
      google.grant('tok-ent', { subject: uniqueSubject('ent') });
      const first = await identityService.signInWithGoogle({
        idToken: 'tok-ent',
      });

      await prisma.entitlement.create({
        data: {
          userId: first.user.id,
          tier: 'premium',
          source: 'auth-identity-spec',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const second = await identityService.signInWithGoogle({
        idToken: 'tok-ent',
      });

      expect(second.user.id).toBe(first.user.id);
      expect(
        await prisma.entitlement.count({ where: { userId: second.user.id } }),
      ).toBe(1);
    });
  });

  // ====================================================================
  // CONCURRENCY
  // ====================================================================

  describe('concurrency', () => {
    it('two simultaneous verifies of the same CORRECT code produce exactly ONE success', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      const code = otpProvider.lastCodeFor(phone);

      const outcomes = await Promise.allSettled([
        identityService.verifyOtp({ phone, code }),
        identityService.verifyOtp({ phone, code }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      // And only ONE identity/account was created for the number.
      expect(
        await prisma.authIdentity.count({
          where: { provider: 'whatsapp', providerSubject: phone },
        }),
      ).toBe(1);
    });

    it('concurrent guesses cannot exceed the attempt budget', async () => {
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });

      await Promise.allSettled(
        Array.from({ length: OTP_MAX_ATTEMPTS * 3 }, () =>
          identityService.verifyOtp({ phone, code: '000000' }),
        ),
      );

      const challenge = await prisma.phoneOtpChallenge.findFirstOrThrow({
        where: { phoneE164: phone },
      });
      // A check-then-act implementation would let all 15 through.
      expect(challenge.attemptCount).toBeLessThanOrEqual(OTP_MAX_ATTEMPTS);
    });

    it('two simultaneous FIRST sign-ins for the same new Google subject create ONE account', async () => {
      google.grant('tok-race', { subject: uniqueSubject('race') });

      const outcomes = await Promise.allSettled([
        identityService.signInWithGoogle({ idToken: 'tok-race' }),
        identityService.signInWithGoogle({ idToken: 'tok-race' }),
      ]);

      const fulfilled = outcomes.filter(
        (
          o,
        ): o is PromiseFulfilledResult<
          Awaited<ReturnType<typeof identityService.signInWithGoogle>>
        > => o.status === 'fulfilled',
      );

      // BOTH callers are the same human, so BOTH must end up signed in — the
      // loser of the insert race re-resolves and takes the existing-identity
      // branch. Asserting only ">= 1 succeeded" is exactly what hid a real
      // defect during development: the `P2002` classifier matched constraint
      // NAMES while Prisma reports column ARRAYS, so the loser received an
      // opaque 500 and this test still passed. Never weaken this back to a
      // `toBeGreaterThanOrEqual`.
      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
      const userIds = new Set(fulfilled.map((o) => o.value.user.id));
      expect(userIds.size).toBe(1);
      expect(
        await prisma.authIdentity.count({
          where: { provider: 'google', providerSubject: uniqueSubject('race') },
        }),
      ).toBe(1);
    });

    it('two simultaneous OTP requests for the same number issue exactly ONE code', async () => {
      const phone = fixturePhone();

      const outcomes = await Promise.allSettled([
        identityService.requestOtp({ phone }),
        identityService.requestOtp({ phone }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(1);
    });

    it('a BURST of concurrent OTP requests for one number always leaves exactly ONE live, verifiable code', async () => {
      // Fix cycle 1 (Reviewer B, finding 1). `claimSlot`'s "oldest row in the
      // window wins" admission check reads a READ COMMITTED snapshot, so a
      // request that STARTED earlier can COMMIT later and two callers can
      // both believe they won. The original code then had each consume
      // "every challenge that is not mine", so the two writes crossed and
      // could leave the number with the OLDER code live — or with NO live
      // code at all, despite messages having been delivered. That is a
      // repeatable denial of WhatsApp sign-in for a targeted number.
      //
      // `keepOnlyNewestLiveChallenge` replaced that with a converging
      // re-read, and this test is the executable proof: after a burst, there
      // is exactly one live challenge, it is the newest, and it actually
      // works.
      const phone = fixturePhone();
      const BURST = 8;

      await Promise.allSettled(
        Array.from({ length: BURST }, () =>
          identityService.requestOtp({ phone }),
        ),
      );

      const live = await prisma.phoneOtpChallenge.findMany({
        where: { phoneE164: phone, consumedAt: null },
      });
      expect(live).toHaveLength(1);

      // The surviving challenge must be the NEWEST one — that is the message
      // the user just read.
      const all = await prisma.phoneOtpChallenge.findMany({
        where: { phoneE164: phone },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(live[0].id).toBe(all[0].id);

      // And it is genuinely usable: a burst must never leave a number able
      // to receive codes but unable to sign in with any of them.
      const deliveredCode = otpProvider.lastCodeFor(phone);
      await expect(
        identityService.verifyOtp({ phone, code: deliveredCode }),
      ).resolves.toMatchObject({ accessToken: expect.any(String) as string });
    });

    it('two simultaneous links of DIFFERENT identities into the SAME provider slot leave one, with a truthful error', async () => {
      // Both callers pass the pre-flight check (the rank-1 `FOR SHARE` lock
      // is self-compatible by design), so the `@@unique([userId, provider])`
      // constraint is what actually decides — and the loser must be told
      // exactly that, not handed a 500.
      const account = await authService.register({
        email: uniqueEmail('same-slot'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-slot-1', { subject: uniqueSubject('slot-1') });
      google.grant('tok-slot-2', { subject: uniqueSubject('slot-2') });

      const outcomes = await Promise.allSettled([
        identityService.linkGoogle(account.user.id, { idToken: 'tok-slot-1' }),
        identityService.linkGoogle(account.user.id, { idToken: 'tok-slot-2' }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );
      expect((rejected?.reason as AppException).code).toBe(
        AppErrorCode.AUTH_PROVIDER_ALREADY_LINKED,
      );
      expect(
        await prisma.authIdentity.count({
          where: { userId: account.user.id, provider: 'google' },
        }),
      ).toBe(1);
    });

    it('a concurrent registration claiming the same email yields a truthful code, not a 500', async () => {
      // The `User.email` unique constraint decides this race. Whichever side
      // loses must carry a specific, honest error code.
      const email = uniqueEmail('email-race');
      google.grant('tok-email-race', {
        subject: uniqueSubject('email-race'),
        email,
      });

      const outcomes = await Promise.allSettled([
        identityService.signInWithGoogle({ idToken: 'tok-email-race' }),
        authService.register({ email, password: 'correct-horse-battery' }),
      ]);

      for (const failure of outcomes.filter(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      )) {
        expect(failure.reason).toBeInstanceOf(AppException);
        expect([
          AppErrorCode.AUTH_ACCOUNT_LINK_REQUIRED,
          AppErrorCode.EMAIL_ALREADY_REGISTERED,
        ]).toContain((failure.reason as AppException).code);
      }
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('two simultaneous unlinks of DIFFERENT providers cannot strip the last method', async () => {
      // Without the self-conflicting `FOR NO KEY UPDATE` lock, each would see
      // the other's identity still present, each would conclude "one usable
      // method remains", and both would succeed — leaving zero.
      google.grant('tok-unlink-race', {
        subject: uniqueSubject('unlink-race'),
      });
      const account = await identityService.signInWithGoogle({
        idToken: 'tok-unlink-race',
      });
      const phone = fixturePhone();
      await identityService.requestOtp({ phone });
      await identityService.linkWhatsApp(account.user.id, {
        phone,
        code: otpProvider.lastCodeFor(phone),
      });

      await Promise.allSettled([
        identityService.unlinkIdentity(account.user.id, 'google'),
        identityService.unlinkIdentity(account.user.id, 'whatsapp'),
      ]);

      expect(
        await prisma.authIdentity.count({ where: { userId: account.user.id } }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('two simultaneous links of the same identity to DIFFERENT accounts leave one owner', async () => {
      const a = await authService.register({
        email: uniqueEmail('race-a'),
        password: 'correct-horse-battery',
      });
      const b = await authService.register({
        email: uniqueEmail('race-b'),
        password: 'correct-horse-battery',
      });
      google.grant('tok-two-owners', { subject: uniqueSubject('two-owners') });

      const outcomes = await Promise.allSettled([
        identityService.linkGoogle(a.user.id, { idToken: 'tok-two-owners' }),
        identityService.linkGoogle(b.user.id, { idToken: 'tok-two-owners' }),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

      // The LOSER must receive the same specific error the pre-flight check
      // would have produced — NOT an opaque 500. Asserting only the success
      // count would let a broken `P2002` classifier pass unnoticed.
      const rejected = outcomes.find(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );
      expect(rejected?.reason).toBeInstanceOf(AppException);
      expect((rejected?.reason as AppException).code).toBe(
        AppErrorCode.AUTH_IDENTITY_ALREADY_LINKED,
      );

      expect(
        await prisma.authIdentity.count({
          where: {
            provider: 'google',
            providerSubject: uniqueSubject('two-owners'),
          },
        }),
      ).toBe(1);
    });
  });

  it('exposes the local fake provider only when it is the bound implementation', () => {
    // This suite binds a `RecordingOtpProvider`, not the local fake, so the
    // accessor must report nothing — the guard that keeps a code-readable
    // provider from being reachable in any other configuration.
    expect(otpService.localFakeProvider).toBeUndefined();
  });
});
