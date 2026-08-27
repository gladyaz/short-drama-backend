import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthAuditService } from '../auth-audit.service';
import { AccountDeletionDto } from '../dto/account-deletion.dto';
import {
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from '../identity/auth-identity.constants';
import { GOOGLE_IDENTITY_VERIFIER } from '../identity/google/google-identity.types';
import type {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from '../identity/google/google-identity.types';
import { GoogleTokenRejected } from '../identity/google/google-id-token.util';
import { LocalFakeWhatsAppOtpProvider } from '../identity/whatsapp/whatsapp-local-fake.provider';
import { WhatsAppOtpService } from '../identity/whatsapp/whatsapp-otp.service';
import {
  WHATSAPP_OTP_PROVIDER,
  WhatsAppDeliveryError,
} from '../identity/whatsapp/whatsapp-otp.types';
import type { SendWhatsAppOtpInput } from '../identity/whatsapp/whatsapp-otp.types';
import { bcryptTestBudgetMs } from '../../common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  TEST_FIXTURE_PHONE_PREFIX,
  fixtureEmail,
  fixturePhone,
} from '../../common/testing/fixture-namespace.helpers';
import { DeletionAuthorizationService } from './deletion-authorization.service';

/**
 * V1 PROVIDER ACCOUNT DELETION — the proof gate, against a REAL database.
 *
 * WHAT THIS FILE IS FOR. `AuthService.deleteAccount` is the transaction;
 * this is the decision that lets it run. The defect being repaired lived
 * entirely in that decision — a Google-only or WhatsApp-only account was
 * refused because the only proof the code knew about was a password those
 * accounts never had — so the proof matrix is what needs exhaustive
 * coverage, and it is what this file provides.
 *
 * NO REAL PROVIDER IS CONTACTED, EVER. `GOOGLE_IDENTITY_VERIFIER` is a
 * scripted double, and `WHATSAPP_OTP_PROVIDER` is the real
 * `LocalFakeWhatsAppOtpProvider` — the same class production binds in a
 * development environment, which delivers nothing anywhere. Both are
 * substituted at production's OWN DI seams, so the code under test is the
 * production code path, not a parallel one.
 *
 * The database, however, is real: `PhoneOtpChallenge`'s single-use claim,
 * expiry and attempt budget are database behaviours, and a test that mocked
 * them would prove nothing about the properties this design leans on.
 * `DATABASE_URL` is redirected to `DATABASE_URL_TEST` in `beforeAll`,
 * matching `account-deletion.service.spec.ts`'s identical, documented
 * precedent — these tests write and delete real rows.
 */
jest.setTimeout(bcryptTestBudgetMs(6));

const TEST_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

/** Scripted Google verifier — identical in shape to `auth-identities.e2e-spec.ts`'s. */
class ScriptedGoogleVerifier implements GoogleIdentityVerifier {
  private readonly identities = new Map<string, GoogleVerifiedIdentity>();

  grant(token: string, identity: GoogleVerifiedIdentity): void {
    this.identities.set(token, identity);
  }

  reset(): void {
    this.identities.clear();
  }

  verifyIdToken(idToken: string): Promise<GoogleVerifiedIdentity> {
    const identity = this.identities.get(idToken);
    return identity
      ? Promise.resolve(identity)
      : Promise.reject(new GoogleTokenRejected('bad_signature'));
  }
}

/** `LocalFakeWhatsAppOtpProvider` with a switch for making one send fail. */
class ControllableFakeOtpProvider extends LocalFakeWhatsAppOtpProvider {
  failWith: 'provider_unavailable' | 'recipient_rejected' | undefined;

  override sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
    if (this.failWith !== undefined) {
      return Promise.reject(
        new WhatsAppDeliveryError(this.failWith, 'spec simulated failure'),
      );
    }
    return super.sendOtp(input);
  }
}

describe('DeletionAuthorizationService', () => {
  let service: DeletionAuthorizationService;
  let prisma: PrismaService;
  let google: ScriptedGoogleVerifier;
  let otpProvider: ControllableFakeOtpProvider;
  let identityConfig: { googleEnabled: boolean; whatsappEnabled: boolean };
  let originalDatabaseUrl: string | undefined;

  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`da-${label}`);
  const uniqueSubject = (label: string): string =>
    `${TEST_FIXTURE_NAMESPACE}-gsub-${label}`;

  beforeAll(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!process.env.DATABASE_URL_TEST) {
      throw new Error(
        'DATABASE_URL_TEST is not set in .env — deletion-authorization tests ' +
          'create and hard-delete real accounts and must run against the ' +
          'dedicated test database, never DATABASE_URL (dev).',
      );
    }

    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    google = new ScriptedGoogleVerifier();
    // Constructed with an explicit `'test'` rather than reading `NODE_ENV`,
    // so this line also documents the class's own refusal to exist outside
    // development/test — passing anything else throws.
    otpProvider = new ControllableFakeOtpProvider('test');
    identityConfig = { googleEnabled: true, whatsappEnabled: true };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeletionAuthorizationService,
        PrismaService,
        AuthAuditService,
        WhatsAppOtpService,
        { provide: GOOGLE_IDENTITY_VERIFIER, useValue: google },
        { provide: WHATSAPP_OTP_PROVIDER, useValue: otpProvider },
        {
          provide: ConfigService,
          useValue: {
            // Keyed rather than a single blanket return value: this service
            // reads BOTH `auth` (for the OTP HMAC key, via
            // `WhatsAppOtpService`) and `identityProviders` (for the feature
            // flags), and conflating them would let a test pass while the
            // real config lookup was wrong.
            get: jest.fn((key: string) =>
              key === 'identityProviders'
                ? identityConfig
                : key === 'app'
                  ? { devToolsEnabled: false }
                  : TEST_CONFIG,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(DeletionAuthorizationService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.authAuditEvent.deleteMany({
      where: { user: { email: { startsWith: emailPrefix } } },
    });
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
    await prisma.phoneOtpChallenge.deleteMany({
      where: { phoneE164: { startsWith: TEST_FIXTURE_PHONE_PREFIX } },
    });
    await prisma.onModuleDestroy();
  });

  // =====================================================================
  // Fixtures
  // =====================================================================

  async function createPasswordAccount(
    label: string,
    password = 'correct-horse-battery',
  ): Promise<string> {
    const email = uniqueEmail(label);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 4),
        authIdentities: {
          create: { provider: 'email', providerSubject: email },
        },
      },
      select: { id: true },
    });
    return user.id;
  }

  async function createGoogleAccount(
    label: string,
  ): Promise<{ userId: string; subject: string }> {
    const subject = uniqueSubject(label);
    const user = await prisma.user.create({
      data: {
        email: uniqueEmail(label),
        passwordHash: null,
        authIdentities: {
          create: {
            provider: 'google',
            providerSubject: subject,
            verifiedAt: new Date(),
          },
        },
      },
      select: { id: true },
    });
    return { userId: user.id, subject };
  }

  async function createWhatsAppAccount(): Promise<{
    userId: string;
    phone: string;
  }> {
    const phone = fixturePhone();
    const user = await prisma.user.create({
      data: {
        email: null,
        passwordHash: null,
        authIdentities: {
          create: {
            provider: 'whatsapp',
            providerSubject: phone,
            normalizedIdentifier: phone,
            verifiedAt: new Date(),
          },
        },
      },
      select: { id: true },
    });
    return { userId: user.id, phone };
  }

  /** Runs the real request-a-code step and reads the code back off the fake provider. */
  async function requestDeletionCode(
    userId: string,
    phone: string,
  ): Promise<string> {
    await service.requestWhatsAppChallenge(userId);
    const code = otpProvider.lastCodeFor(phone);
    if (!code) {
      throw new Error(`fake provider recorded no code for ${phone}`);
    }
    return code;
  }

  /** A deletion body with the confirmation flag already set. */
  const body = (fields: Partial<AccountDeletionDto>): AccountDeletionDto => ({
    confirmDeletion: true,
    ...fields,
  });

  async function expectAppError(
    promise: Promise<unknown>,
    code: AppErrorCode,
    status: HttpStatus,
  ): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(AppException);
    await promise.catch((error: AppException) => {
      expect(error.code).toBe(code);
      expect(error.getStatus()).toBe(status);
    });
  }

  // =====================================================================
  // Discovery
  // =====================================================================

  describe('availableMethods', () => {
    it('offers "password" for a password account and nothing else', async () => {
      const userId = await createPasswordAccount('methods-pw');
      await expect(service.availableMethods(userId)).resolves.toEqual([
        'password',
      ]);
    });

    it('CRITICAL: offers "google" for a Google-only account — the case that previously had NO deletion path at all', async () => {
      const { userId } = await createGoogleAccount('methods-google');
      await expect(service.availableMethods(userId)).resolves.toEqual([
        'google',
      ]);
    });

    it('CRITICAL: offers "whatsapp" for a WhatsApp-only account — the other case that previously had none', async () => {
      const { userId } = await createWhatsAppAccount();
      await expect(service.availableMethods(userId)).resolves.toEqual([
        'whatsapp',
      ]);
    });

    it('offers every method a multi-identity account owns, in a stable order', async () => {
      const userId = await createPasswordAccount('methods-multi');
      const phone = fixturePhone();
      await prisma.authIdentity.createMany({
        data: [
          {
            userId,
            provider: 'google',
            providerSubject: uniqueSubject('multi'),
          },
          {
            userId,
            provider: 'whatsapp',
            providerSubject: phone,
            normalizedIdentifier: phone,
          },
        ],
      });

      await expect(service.availableMethods(userId)).resolves.toEqual([
        'password',
        'google',
        'whatsapp',
      ]);
    });

    it('withholds a provider this server cannot verify, rather than offering a door that is painted on', async () => {
      const { userId } = await createGoogleAccount('methods-disabled');
      identityConfig.googleEnabled = false;

      await expect(service.availableMethods(userId)).resolves.toEqual([]);
    });

    it('does not count an "email" identity as a password when the account has no hash', async () => {
      const email = uniqueEmail('methods-nohash');
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash: null,
          authIdentities: {
            create: { provider: 'email', providerSubject: email },
          },
        },
        select: { id: true },
      });

      await expect(service.availableMethods(user.id)).resolves.toEqual([]);
    });
  });

  // =====================================================================
  // Password
  // =====================================================================

  describe('password proof', () => {
    it('authorizes with the correct current password', async () => {
      const userId = await createPasswordAccount('pw-ok');

      await expect(
        service.authorize(
          userId,
          body({ currentPassword: 'correct-horse-battery' }),
        ),
      ).resolves.toEqual({
        method: 'password',
        userId,
        whatsappPhoneE164: null,
      });
    });

    it('accepts the LEGACY body shape (no "method" field) unchanged', async () => {
      const userId = await createPasswordAccount('pw-legacy');

      // Exactly the body every existing client already sends.
      const authorization = await service.authorize(userId, {
        currentPassword: 'correct-horse-battery',
        confirmDeletion: true,
      });

      expect(authorization.method).toBe('password');
    });

    it('rejects a wrong password with the SAME generic INVALID_CREDENTIALS as before', async () => {
      const userId = await createPasswordAccount('pw-wrong');

      await expectAppError(
        service.authorize(
          userId,
          body({ currentPassword: 'not-the-password' }),
        ),
        AppErrorCode.INVALID_CREDENTIALS,
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('CRITICAL: a passwordless account asked for a password proof gets the actionable ACCOUNT_DELETION_METHOD_UNAVAILABLE, not a false "wrong password"', async () => {
      const { userId } = await createGoogleAccount('pw-none');

      await expectAppError(
        service.authorize(userId, body({ currentPassword: 'anything' })),
        AppErrorCode.ACCOUNT_DELETION_METHOD_UNAVAILABLE,
        HttpStatus.CONFLICT,
      );
    });
  });

  // =====================================================================
  // Google
  // =====================================================================

  describe('google proof', () => {
    it('CRITICAL: a Google-only account authorizes its own deletion with a fresh Google ID token', async () => {
      const { userId, subject } = await createGoogleAccount('g-ok');
      google.grant('tok-ok', { subject });

      await expect(
        service.authorize(
          userId,
          body({ method: 'google', idToken: 'tok-ok' }),
        ),
      ).resolves.toEqual({
        method: 'google',
        userId,
        whatsappPhoneE164: null,
      });
    });

    it('CRITICAL: a VALID Google credential belonging to a DIFFERENT account is refused — proof is bound to the caller', async () => {
      const victim = await createGoogleAccount('g-victim');
      const attacker = await createGoogleAccount('g-attacker');
      // The attacker holds a genuine, correctly-signed token for their OWN
      // Google account, and a valid access token for their own Red Panda
      // account. Neither fact may authorize deleting the victim's account.
      google.grant('tok-attacker', { subject: attacker.subject });

      await expectAppError(
        service.authorize(
          victim.userId,
          body({ method: 'google', idToken: 'tok-attacker' }),
        ),
        AppErrorCode.ACCOUNT_DELETION_PROOF_MISMATCH,
        HttpStatus.UNAUTHORIZED,
      );

      // And the victim's account is entirely untouched.
      await expect(
        prisma.user.findUnique({ where: { id: victim.userId } }),
      ).resolves.not.toBeNull();
    });

    it('rejects a malformed / unverifiable Google credential with the generic INVALID_GOOGLE_TOKEN', async () => {
      const { userId } = await createGoogleAccount('g-bad');

      await expectAppError(
        service.authorize(
          userId,
          body({ method: 'google', idToken: 'not-a-real-token' }),
        ),
        AppErrorCode.INVALID_GOOGLE_TOKEN,
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('CRITICAL: matches on the Google `sub`, never on the email — a token with the right email and a different subject is refused', async () => {
      const { userId, subject } = await createGoogleAccount('g-email');
      const account = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      google.grant('tok-same-email', {
        subject: `${subject}-DIFFERENT`,
        email: account!.email!,
      });

      await expectAppError(
        service.authorize(
          userId,
          body({ method: 'google', idToken: 'tok-same-email' }),
        ),
        AppErrorCode.ACCOUNT_DELETION_PROOF_MISMATCH,
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('refuses a google proof on an account with no linked Google identity', async () => {
      const userId = await createPasswordAccount('g-unlinked');
      google.grant('tok-unlinked', { subject: uniqueSubject('unlinked') });

      await expectAppError(
        service.authorize(
          userId,
          body({ method: 'google', idToken: 'tok-unlinked' }),
        ),
        AppErrorCode.ACCOUNT_DELETION_METHOD_UNAVAILABLE,
        HttpStatus.CONFLICT,
      );
    });

    it('refuses a google proof when this server has Google verification disabled', async () => {
      const { userId, subject } = await createGoogleAccount('g-off');
      google.grant('tok-off', { subject });
      identityConfig.googleEnabled = false;

      await expectAppError(
        service.authorize(
          userId,
          body({ method: 'google', idToken: 'tok-off' }),
        ),
        AppErrorCode.ACCOUNT_DELETION_METHOD_UNAVAILABLE,
        HttpStatus.CONFLICT,
      );
    });
  });

  // =====================================================================
  // WhatsApp
  // =====================================================================

  describe('whatsapp proof', () => {
    it('CRITICAL: a WhatsApp-only account authorizes its own deletion with a real, delivered one-time code', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      const code = await requestDeletionCode(userId, phone);

      await expect(
        service.authorize(userId, body({ method: 'whatsapp', code })),
      ).resolves.toEqual({
        method: 'whatsapp',
        userId,
        whatsappPhoneE164: phone,
      });
    });

    it('sends the code to the account’s OWN linked number — the request body cannot redirect it', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      await service.requestWhatsAppChallenge(userId);

      const challenges = await prisma.phoneOtpChallenge.findMany({
        where: { purpose: 'account_deletion' },
        select: { phoneE164: true },
      });
      expect(challenges.map((row) => row.phoneE164)).toEqual([phone]);
    });

    it('rejects an invalid code with the generic INVALID_OTP', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      const code = await requestDeletionCode(userId, phone);
      const wrong = code === '000000' ? '111111' : '000000';

      await expectAppError(
        service.authorize(userId, body({ method: 'whatsapp', code: wrong })),
        AppErrorCode.INVALID_OTP,
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('rejects an EXPIRED code', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      const code = await requestDeletionCode(userId, phone);

      // Age the challenge past its TTL at the database level, rather than
      // waiting five real minutes — the expiry itself is enforced by the
      // `expiresAt > now` predicate in `claimChallenge`'s conditional UPDATE.
      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone, purpose: 'account_deletion' },
        data: { expiresAt: new Date(Date.now() - OTP_TTL_MS) },
      });

      await expectAppError(
        service.authorize(userId, body({ method: 'whatsapp', code })),
        AppErrorCode.INVALID_OTP,
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('CRITICAL: a code is single-use — the same correct code cannot be replayed', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      const code = await requestDeletionCode(userId, phone);

      await expect(
        service.authorize(userId, body({ method: 'whatsapp', code })),
      ).resolves.toMatchObject({ method: 'whatsapp' });

      await expectAppError(
        service.authorize(userId, body({ method: 'whatsapp', code })),
        AppErrorCode.INVALID_OTP,
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('CRITICAL: two concurrent submissions of the SAME correct code authorize exactly once', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      const code = await requestDeletionCode(userId, phone);

      const outcomes = await Promise.allSettled([
        service.authorize(userId, body({ method: 'whatsapp', code })),
        service.authorize(userId, body({ method: 'whatsapp', code })),
      ]);

      expect(
        outcomes.filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1);
    });

    it('surfaces a provider outage rather than pretending a code was sent', async () => {
      const { userId } = await createWhatsAppAccount();
      otpProvider.failWith = 'provider_unavailable';

      await expectAppError(
        service.requestWhatsAppChallenge(userId),
        AppErrorCode.WHATSAPP_PROVIDER_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    });

    it('refuses to send a deletion code to an account with no linked number', async () => {
      const userId = await createPasswordAccount('wa-unlinked');

      await expectAppError(
        service.requestWhatsAppChallenge(userId),
        AppErrorCode.ACCOUNT_DELETION_METHOD_UNAVAILABLE,
        HttpStatus.CONFLICT,
      );
    });

    it('answers the per-number resend cooldown with OTP_RESEND_COOLDOWN', async () => {
      const { userId } = await createWhatsAppAccount();
      await service.requestWhatsAppChallenge(userId);

      await expectAppError(
        service.requestWhatsAppChallenge(userId),
        AppErrorCode.OTP_RESEND_COOLDOWN,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });
  });

  // =====================================================================
  // Purpose isolation
  // =====================================================================

  describe('challenge purpose isolation', () => {
    it('CRITICAL: a DELETION code cannot be redeemed as a LOGIN code — it must never mint a session', async () => {
      const { userId, phone } = await createWhatsAppAccount();
      const deletionCode = await requestDeletionCode(userId, phone);

      const otpService = new WhatsAppOtpService(
        prisma,
        {
          get: jest.fn((key: string) =>
            key === 'app' ? { devToolsEnabled: false } : TEST_CONFIG,
          ),
        } as never,
        otpProvider,
      );

      // The login namespace has no challenge for this number at all, so the
      // deletion code is not merely wrong there — it is invisible.
      await expect(
        otpService.claimChallenge(phone, 'login', deletionCode),
      ).rejects.toMatchObject({ reason: 'otp_not_found' });

      // ...and it is still perfectly usable for the thing it WAS issued for.
      await expect(
        service.authorize(
          userId,
          body({ method: 'whatsapp', code: deletionCode }),
        ),
      ).resolves.toMatchObject({ method: 'whatsapp' });
    });

    it('CRITICAL: issuing a deletion challenge does not kill the number’s live LOGIN code', async () => {
      const { userId, phone } = await createWhatsAppAccount();

      const otpService = new WhatsAppOtpService(
        prisma,
        {
          get: jest.fn((key: string) =>
            key === 'app' ? { devToolsEnabled: false } : TEST_CONFIG,
          ),
        } as never,
        otpProvider,
      );
      await otpService.issueChallenge(phone, 'login', {});
      const loginCode = otpProvider.lastCodeFor(phone)!;

      // Aged past the per-number cooldown, which is DELIBERATELY shared
      // across purposes (a message costs its recipient the same whatever it
      // was for) — so this is the first moment a deletion challenge for this
      // number can be admitted at all. With a SHARED live slot, admitting it
      // is exactly what would retire the login challenge above and leave the
      // user holding a dead code.
      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 2 * OTP_RESEND_COOLDOWN_MS) },
      });

      await expect(
        service.requestWhatsAppChallenge(userId),
      ).resolves.toMatchObject({ success: true });

      const live = await prisma.phoneOtpChallenge.findMany({
        where: { phoneE164: phone, consumedAt: null },
        select: { purpose: true },
      });
      expect(live.map((row) => row.purpose).sort()).toEqual([
        'account_deletion',
        'login',
      ]);

      // The login code still works, for logging in, and is untouched by the
      // deletion challenge that now coexists with it.
      await expect(
        otpService.claimChallenge(phone, 'login', loginCode),
      ).resolves.toBeUndefined();
    });
  });

  // =====================================================================
  // Cross-cutting
  // =====================================================================

  describe('cross-cutting', () => {
    it('CRITICAL: every authorization it returns names the account it was verified against', async () => {
      const passwordUser = await createPasswordAccount('bind-pw');
      const googleUser = await createGoogleAccount('bind-g');
      const whatsAppUser = await createWhatsAppAccount();
      google.grant('tok-bind', { subject: googleUser.subject });
      const code = await requestDeletionCode(
        whatsAppUser.userId,
        whatsAppUser.phone,
      );

      const results = [
        await service.authorize(
          passwordUser,
          body({ currentPassword: 'correct-horse-battery' }),
        ),
        await service.authorize(
          googleUser.userId,
          body({ method: 'google', idToken: 'tok-bind' }),
        ),
        await service.authorize(
          whatsAppUser.userId,
          body({ method: 'whatsapp', code }),
        ),
      ];

      expect(results.map((result) => result.userId)).toEqual([
        passwordUser,
        googleUser.userId,
        whatsAppUser.userId,
      ]);
    });

    it('reports a vanished account as INVALID_ACCESS_TOKEN, matching every other "user no longer exists" path', async () => {
      const userId = await createPasswordAccount('gone');
      await prisma.user.delete({ where: { id: userId } });

      await expectAppError(
        service.authorize(
          userId,
          body({ currentPassword: 'correct-horse-battery' }),
        ),
        AppErrorCode.INVALID_ACCESS_TOKEN,
        HttpStatus.UNAUTHORIZED,
      );
    });
  });
});
