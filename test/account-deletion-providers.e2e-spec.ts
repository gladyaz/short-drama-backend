import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { RootConfig } from './../src/config/configuration';
import type { AccountDeletionMethodsDto } from './../src/auth/deletion/deletion-authorization.types';
import { GOOGLE_IDENTITY_VERIFIER } from './../src/auth/identity/google/google-identity.types';
import type {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './../src/auth/identity/google/google-identity.types';
import { GoogleTokenRejected } from './../src/auth/identity/google/google-id-token.util';
import {
  WHATSAPP_OTP_PROVIDER,
  WhatsAppDeliveryError,
} from './../src/auth/identity/whatsapp/whatsapp-otp.types';
import type {
  SendWhatsAppOtpInput,
  WhatsAppDeliveryFailureKind,
} from './../src/auth/identity/whatsapp/whatsapp-otp.types';
import { LocalFakeWhatsAppOtpProvider } from './../src/auth/identity/whatsapp/whatsapp-local-fake.provider';
import {
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from './../src/auth/identity/auth-identity.constants';
import { bcryptTestBudgetMs } from './../src/common/testing/bcrypt-test-budget.helpers';
import {
  TEST_FIXTURE_NAMESPACE,
  TEST_FIXTURE_PHONE_PREFIX,
  fixtureEmail,
  fixturePhone,
} from './../src/common/testing/fixture-namespace.helpers';
import { resetThrottlerStorage } from './../src/common/testing/throttler-reset.helpers';

/**
 * V1 PROVIDER ACCOUNT DELETION — e2e.
 *
 * THE ONE SENTENCE THIS FILE EXISTS TO PROVE: an account created with
 * GOOGLE, and an account created with WHATSAPP, can each delete themselves
 * over real HTTP — which, before this work unit, neither could.
 *
 * Everything runs through the real stack: routing, `JwtAuthGuard`, the
 * global `ValidationPipe`, the per-route `@Throttle()` overrides,
 * `AppExceptionFilter`, and a real database. The accounts are created
 * through the REAL sign-in routes (`POST /auth/google`,
 * `POST /auth/whatsapp/otp/*`), not by inserting rows — so the identities
 * these tests then delete are exactly the identities production would have
 * created.
 *
 * TWO SUBSTITUTIONS, BOTH AT PRODUCTION'S OWN DI SEAMS, matching
 * `auth-identities.e2e-spec.ts` exactly: a scripted `GOOGLE_IDENTITY_VERIFIER`
 * (so this suite never reaches Google) and the REAL
 * `LocalFakeWhatsAppOtpProvider` (the same class production binds in a
 * development environment, which delivers nothing, anywhere). NO REAL GOOGLE
 * OR WHATSAPP REQUEST IS MADE BY THIS SUITE.
 */
jest.setTimeout(bcryptTestBudgetMs(10));

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

class ScriptedGoogleVerifier implements GoogleIdentityVerifier {
  private readonly identities = new Map<string, GoogleVerifiedIdentity>();

  grant(token: string, identity: GoogleVerifiedIdentity): void {
    this.identities.set(token, identity);
  }

  verifyIdToken(idToken: string): Promise<GoogleVerifiedIdentity> {
    const identity = this.identities.get(idToken);
    return identity
      ? Promise.resolve(identity)
      : Promise.reject(new GoogleTokenRejected('bad_signature'));
  }
}

describe('Account deletion by identity provider (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;
  let google: ScriptedGoogleVerifier;
  let fakeOtpProvider: ControllableFakeOtpProvider;

  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`adp-${label}`);
  const uniqueSubject = (label: string): string =>
    `${TEST_FIXTURE_NAMESPACE}-adp-${label}`;
  // A successful deletion emits `account_deletion_success` WITHOUT a
  // `userId` (by design — see `AuthService.deleteAccount`), so the row cannot
  // be found through a `user.email` join afterwards. Every deletion request
  // below therefore carries this marker `User-Agent` so `afterAll` can still
  // find and remove it, matching `account-deletion.e2e-spec.ts`'s precedent.
  const deletionUserAgent = `${emailPrefix}-provider-deletion-agent`;

  class ControllableFakeOtpProvider extends LocalFakeWhatsAppOtpProvider {
    failWith: WhatsAppDeliveryFailureKind | undefined;

    override sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
      if (this.failWith !== undefined) {
        return Promise.reject(
          new WhatsAppDeliveryError(this.failWith, 'e2e simulated failure'),
        );
      }
      return super.sendOtp(input);
    }
  }

  beforeAll(async () => {
    google = new ScriptedGoogleVerifier();
    fakeOtpProvider = new ControllableFakeOtpProvider('test');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GOOGLE_IDENTITY_VERIFIER)
      .useValue(google)
      .overrideProvider(WHATSAPP_OTP_PROVIDER)
      .useValue(fakeOtpProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AppExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(getStorageToken());

    // The identity flags are OFF by default in this repository, so a boot
    // from real config would answer 503 to every route under test.
    // `ConfigService` is not stubbed wholesale — that would bypass the
    // wiring this suite exists to exercise — so the flags are flipped on the
    // resolved config object the app already holds, exactly as
    // `auth-identities.e2e-spec.ts` does.
    const identityConfig = moduleFixture
      .get<ConfigService<RootConfig>>(ConfigService)
      .get('identityProviders', { infer: true })!;
    identityConfig.googleEnabled = true;
    identityConfig.whatsappEnabled = true;
  });

  beforeEach(() => {
    resetThrottlerStorage(throttlerStorage);
    fakeOtpProvider.reset();
    fakeOtpProvider.failWith = undefined;
  });

  afterAll(async () => {
    await prisma.authAuditEvent.deleteMany({
      where: { userAgent: { startsWith: deletionUserAgent } },
    });
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
    await app.close();
  });

  const server = () => app.getHttpServer();

  // =====================================================================
  // Fixtures — every account is created through the REAL sign-in routes
  // =====================================================================

  async function signUpWithGoogle(
    label: string,
  ): Promise<{ auth: AuthResponseDto; token: string; subject: string }> {
    const subject = uniqueSubject(label);
    const token = `e2e-adp-${label}`;
    google.grant(token, { subject, email: uniqueEmail(label) });

    const response = await request(server())
      .post('/auth/google')
      .send({ idToken: token })
      .expect(HttpStatus.OK);

    return { auth: response.body as AuthResponseDto, token, subject };
  }

  async function signUpWithWhatsApp(): Promise<{
    auth: AuthResponseDto;
    phone: string;
  }> {
    const phone = fixturePhone();
    await request(server())
      .post('/auth/whatsapp/otp/request')
      .send({ phone })
      .expect(HttpStatus.ACCEPTED);
    const code = fakeOtpProvider.lastCodeFor(phone);
    if (!code) {
      throw new Error(`fake provider recorded no code for ${phone}`);
    }

    const response = await request(server())
      .post('/auth/whatsapp/otp/verify')
      .send({ phone, code })
      .expect(HttpStatus.OK);

    return { auth: response.body as AuthResponseDto, phone };
  }

  async function registerWithPassword(
    label: string,
    password = 'correct-horse-battery',
  ): Promise<{ email: string; auth: AuthResponseDto }> {
    const email = uniqueEmail(label);
    const response = await request(server())
      .post('/auth/register')
      .send({ email, password })
      .expect(HttpStatus.CREATED);
    return { email, auth: response.body as AuthResponseDto };
  }

  /**
   * Requests a deletion code for the caller's own linked number and reads it
   * back off the fake provider — the same "the user read the message" step a
   * real client performs.
   *
   * IT AGES THE NUMBER'S EXISTING CHALLENGES FIRST, and that is not a
   * workaround for a bug: `WhatsAppOtpService`'s per-number resend cooldown
   * is DELIBERATELY shared across purposes (a message costs its recipient
   * the same whatever it was for — see `PhoneOtpChallenge.liveKey`'s schema
   * comment), so the `login` challenge this account signed up with, issued
   * milliseconds ago, correctly refuses a deletion code with `429`. A real
   * user is minutes or days past that point by the time they delete their
   * account; a test cannot wait 60 real seconds per case, so it moves the
   * clock instead — by editing ONLY its own fixture number's rows. The
   * cooldown itself is asserted for real, unmocked, in
   * `deletion-authorization.service.spec.ts`.
   */
  async function requestDeletionCode(
    accessToken: string,
    phone: string,
  ): Promise<string> {
    await prisma.phoneOtpChallenge.updateMany({
      where: { phoneE164: phone },
      data: { createdAt: new Date(Date.now() - 2 * OTP_RESEND_COOLDOWN_MS) },
    });

    await request(server())
      .post('/users/me/deletion/whatsapp/otp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(HttpStatus.ACCEPTED);

    const code = fakeOtpProvider.lastCodeFor(phone);
    if (!code) {
      throw new Error(`fake provider recorded no deletion code for ${phone}`);
    }
    return code;
  }

  const deleteRequest = (accessToken: string) =>
    request(server())
      .post('/users/me/deletion')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('User-Agent', deletionUserAgent);

  // =====================================================================
  // GET /users/me/deletion/methods
  // =====================================================================

  describe('GET /users/me/deletion/methods', () => {
    it('tells a password account to use "password"', async () => {
      const { auth } = await registerWithPassword('methods-pw');

      const response = await request(server())
        .get('/users/me/deletion/methods')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);

      expect(response.body as AccountDeletionMethodsDto).toEqual({
        methods: ['password'],
      });
    });

    it('CRITICAL: tells a Google-only account to use "google"', async () => {
      const { auth } = await signUpWithGoogle('methods-google');

      const response = await request(server())
        .get('/users/me/deletion/methods')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);

      expect(response.body as AccountDeletionMethodsDto).toEqual({
        methods: ['google'],
      });
    });

    it('CRITICAL: tells a WhatsApp-only account to use "whatsapp"', async () => {
      const { auth } = await signUpWithWhatsApp();

      const response = await request(server())
        .get('/users/me/deletion/methods')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);

      expect(response.body as AccountDeletionMethodsDto).toEqual({
        methods: ['whatsapp'],
      });
    });

    it('discloses no identity details — only method names', async () => {
      const { auth, phone } = await signUpWithWhatsApp();

      const response = await request(server())
        .get('/users/me/deletion/methods')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);

      expect(JSON.stringify(response.body)).not.toContain(phone);
    });

    it('rejects an unauthenticated call', async () => {
      await request(server())
        .get('/users/me/deletion/methods')
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  // =====================================================================
  // Password — unchanged behaviour
  // =====================================================================

  describe('password deletion (preserved)', () => {
    it('deletes with the LEGACY body shape, with no "method" field', async () => {
      const password = 'correct-horse-battery';
      const { email, auth } = await registerWithPassword('pw-legacy', password);

      const response = await deleteRequest(auth.accessToken)
        .send({ currentPassword: password, confirmDeletion: true })
        .expect(HttpStatus.OK);
      expect(response.body).toEqual({ success: true });

      await request(server())
        .post('/auth/login')
        .send({ email, password })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('deletes with an EXPLICIT method: "password"', async () => {
      const password = 'correct-horse-battery';
      const { auth } = await registerWithPassword('pw-explicit', password);

      await deleteRequest(auth.accessToken)
        .send({
          method: 'password',
          currentPassword: password,
          confirmDeletion: true,
        })
        .expect(HttpStatus.OK);
    });

    it('still rejects a wrong password with the generic INVALID_CREDENTIALS', async () => {
      const { auth } = await registerWithPassword('pw-wrong');

      const response = await deleteRequest(auth.accessToken)
        .send({ currentPassword: 'not-the-password', confirmDeletion: true })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_CREDENTIALS',
      );
    });

    it('still rejects a MISSING password with a clean 400 from the pipe', async () => {
      const { auth } = await registerWithPassword('pw-missing');

      await deleteRequest(auth.accessToken)
        .send({ confirmDeletion: true })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  // =====================================================================
  // Google
  // =====================================================================

  describe('google deletion', () => {
    it('CRITICAL: a Google-only account deletes itself with a fresh Google ID token — the case that was impossible before', async () => {
      const { auth, token, subject } = await signUpWithGoogle('g-delete');

      const response = await deleteRequest(auth.accessToken)
        .send({ method: 'google', idToken: token, confirmDeletion: true })
        .expect(HttpStatus.OK);
      expect(response.body).toEqual({ success: true });

      // The account, and the identity that could sign back into it, are both
      // gone — so the same Google token now creates a NEW account rather than
      // re-entering the deleted one.
      await expect(
        prisma.authIdentity.findFirst({
          where: { provider: 'google', providerSubject: subject },
        }),
      ).resolves.toBeNull();
    });

    it('CRITICAL: a VALID Google token for a DIFFERENT account is refused, and the target account survives', async () => {
      const victim = await signUpWithGoogle('g-victim');
      const attacker = await signUpWithGoogle('g-attacker');

      const response = await deleteRequest(victim.auth.accessToken)
        .send({
          method: 'google',
          idToken: attacker.token,
          confirmDeletion: true,
        })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ACCOUNT_DELETION_PROOF_MISMATCH',
      );

      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${victim.auth.accessToken}`)
        .expect(HttpStatus.OK);
    });

    it('rejects a malformed Google credential with INVALID_GOOGLE_TOKEN', async () => {
      const { auth } = await signUpWithGoogle('g-malformed');

      const response = await deleteRequest(auth.accessToken)
        .send({
          method: 'google',
          idToken: 'not.a.real.token',
          confirmDeletion: true,
        })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_GOOGLE_TOKEN',
      );
    });

    it('refuses a google proof on an account with no Google identity, and says which methods it CAN use', async () => {
      const { auth } = await registerWithPassword('g-unlinked');

      const response = await deleteRequest(auth.accessToken)
        .send({ method: 'google', idToken: 'anything', confirmDeletion: true })
        .expect(HttpStatus.CONFLICT);

      const body = response.body as ErrorResponseBody;
      expect(body.code).toBe('ACCOUNT_DELETION_METHOD_UNAVAILABLE');
      expect(body.message).toContain('/users/me/deletion/methods');
    });
  });

  // =====================================================================
  // WhatsApp
  // =====================================================================

  describe('whatsapp deletion', () => {
    it('CRITICAL: a WhatsApp-only account deletes itself with a delivered one-time code — the other case that was impossible before', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const code = await requestDeletionCode(auth.accessToken, phone);

      const response = await deleteRequest(auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.OK);
      expect(response.body).toEqual({ success: true });

      await expect(
        prisma.authIdentity.findFirst({
          where: { provider: 'whatsapp', providerSubject: phone },
        }),
      ).resolves.toBeNull();
    });

    it('CRITICAL: every challenge for the number is destroyed with the account', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const code = await requestDeletionCode(auth.accessToken, phone);

      await deleteRequest(auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.OK);

      await expect(
        prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).resolves.toBe(0);
    });

    it('CRITICAL: a DELETION code cannot be used to sign in — it must never mint a session', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const code = await requestDeletionCode(auth.accessToken, phone);

      const response = await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone, code })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe('INVALID_OTP');
    });

    it('rejects an invalid code with INVALID_OTP', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const code = await requestDeletionCode(auth.accessToken, phone);
      const wrong = code === '000000' ? '111111' : '000000';

      const response = await deleteRequest(auth.accessToken)
        .send({ method: 'whatsapp', code: wrong, confirmDeletion: true })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe('INVALID_OTP');
    });

    it('rejects an EXPIRED code', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const code = await requestDeletionCode(auth.accessToken, phone);

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone, purpose: 'account_deletion' },
        data: { expiresAt: new Date(Date.now() - OTP_TTL_MS) },
      });

      const response = await deleteRequest(auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe('INVALID_OTP');
    });

    it('CRITICAL: a code cannot be REUSED — the second account cannot be deleted with the first one’s code', async () => {
      const first = await signUpWithWhatsApp();
      const code = await requestDeletionCode(
        first.auth.accessToken,
        first.phone,
      );

      await deleteRequest(first.auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.OK);

      const second = await signUpWithWhatsApp();
      const response = await deleteRequest(second.auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe('INVALID_OTP');
      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${second.auth.accessToken}`)
        .expect(HttpStatus.OK);
    });

    it('surfaces a provider outage rather than claiming a code was sent', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      // Past the shared per-number cooldown the sign-up above just started —
      // see `requestDeletionCode`'s doc comment. Done inline here because
      // this test deliberately does NOT go through that helper: the send is
      // supposed to fail, so there is no code to read back.
      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 2 * OTP_RESEND_COOLDOWN_MS) },
      });
      fakeOtpProvider.failWith = 'provider_unavailable';

      const response = await request(server())
        .post('/users/me/deletion/whatsapp/otp')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({})
        .expect(HttpStatus.SERVICE_UNAVAILABLE);

      expect((response.body as ErrorResponseBody).code).toBe(
        'WHATSAPP_PROVIDER_UNAVAILABLE',
      );
    });

    it('refuses to send a deletion code for an account with no linked number', async () => {
      const { auth } = await registerWithPassword('wa-unlinked');

      const response = await request(server())
        .post('/users/me/deletion/whatsapp/otp')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({})
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'ACCOUNT_DELETION_METHOD_UNAVAILABLE',
      );
    });

    it('rejects an unauthenticated deletion-code request', async () => {
      await request(server())
        .post('/users/me/deletion/whatsapp/otp')
        .send({})
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  // =====================================================================
  // Cross-cutting
  // =====================================================================

  describe('cross-cutting guarantees', () => {
    it('CRITICAL: confirmDeletion is still required for EVERY method — a valid proof alone never deletes', async () => {
      const googleUser = await signUpWithGoogle('confirm-g');
      const whatsAppUser = await signUpWithWhatsApp();
      const code = await requestDeletionCode(
        whatsAppUser.auth.accessToken,
        whatsAppUser.phone,
      );

      await deleteRequest(googleUser.auth.accessToken)
        .send({ method: 'google', idToken: googleUser.token })
        .expect(HttpStatus.BAD_REQUEST);
      await deleteRequest(googleUser.auth.accessToken)
        .send({
          method: 'google',
          idToken: googleUser.token,
          confirmDeletion: false,
        })
        .expect(HttpStatus.BAD_REQUEST);

      await deleteRequest(whatsAppUser.auth.accessToken)
        .send({ method: 'whatsapp', code })
        .expect(HttpStatus.BAD_REQUEST);

      // Both accounts are still fully alive.
      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${googleUser.auth.accessToken}`)
        .expect(HttpStatus.OK);
      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${whatsAppUser.auth.accessToken}`)
        .expect(HttpStatus.OK);
    });

    it('rejects an unknown method with a clean 400 before any account work', async () => {
      const { auth } = await registerWithPassword('bad-method');

      await deleteRequest(auth.accessToken)
        .send({ method: 'carrier-pigeon', confirmDeletion: true })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('rejects an unauthenticated deletion for every method', async () => {
      for (const payload of [
        { method: 'google', idToken: 'x', confirmDeletion: true },
        { method: 'whatsapp', code: '123456', confirmDeletion: true },
        { currentPassword: 'x', confirmDeletion: true },
      ]) {
        const response = await request(server())
          .post('/users/me/deletion')
          .send(payload)
          .expect(HttpStatus.UNAUTHORIZED);
        expect((response.body as ErrorResponseBody).code).toBe(
          'INVALID_ACCESS_TOKEN',
        );
      }
    });

    it('CRITICAL: every session is revoked and the account cannot authenticate afterward (google)', async () => {
      const { auth, token } = await signUpWithGoogle('g-sessions');
      // A second device, signed in through the same Google identity.
      const secondSignIn = await request(server())
        .post('/auth/google')
        .send({ idToken: token })
        .expect(HttpStatus.OK);
      const secondRefresh = (secondSignIn.body as AuthResponseDto).refreshToken;

      await deleteRequest(auth.accessToken)
        .send({ method: 'google', idToken: token, confirmDeletion: true })
        .expect(HttpStatus.OK);

      // Neither device's refresh token works...
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: auth.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: secondRefresh })
        .expect(HttpStatus.UNAUTHORIZED);

      // ...and the still-unexpired access token no longer resolves to an
      // account, so every authenticated route refuses it.
      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('CRITICAL: every session is revoked and the account cannot authenticate afterward (whatsapp)', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const code = await requestDeletionCode(auth.accessToken, phone);

      await deleteRequest(auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.OK);

      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: auth.refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('CRITICAL: the deleted account leaves no identity behind — the same Google account signs up FRESH, into a different account', async () => {
      const { auth, token, subject } = await signUpWithGoogle('g-rebirth');
      const originalId = (
        await prisma.authIdentity.findFirstOrThrow({
          where: { provider: 'google', providerSubject: subject },
          select: { userId: true },
        })
      ).userId;

      await deleteRequest(auth.accessToken)
        .send({ method: 'google', idToken: token, confirmDeletion: true })
        .expect(HttpStatus.OK);

      const rebirth = await request(server())
        .post('/auth/google')
        .send({ idToken: token })
        .expect(HttpStatus.OK);

      expect((rebirth.body as AuthResponseDto).user.id).not.toBe(originalId);
      await expect(
        prisma.user.findUnique({ where: { id: originalId } }),
      ).resolves.toBeNull();
    });

    it('CRITICAL: two concurrent deletions of the same account are safe — never a 500', async () => {
      const { auth, token } = await signUpWithGoogle('g-concurrent');

      const [first, second] = await Promise.all([
        deleteRequest(auth.accessToken).send({
          method: 'google',
          idToken: token,
          confirmDeletion: true,
        }),
        deleteRequest(auth.accessToken).send({
          method: 'google',
          idToken: token,
          confirmDeletion: true,
        }),
      ]);

      for (const response of [first, second]) {
        expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(
          response.status,
        );
      }
      expect([first.status, second.status]).toContain(HttpStatus.OK);
    });

    it('CRITICAL: the existing cascade still holds — a deleted account leaves no owned rows behind', async () => {
      const { auth, phone } = await signUpWithWhatsApp();
      const me = await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);
      const userId = (me.body as { id: string }).id;

      const code = await requestDeletionCode(auth.accessToken, phone);
      await deleteRequest(auth.accessToken)
        .send({ method: 'whatsapp', code, confirmDeletion: true })
        .expect(HttpStatus.OK);

      await expect(
        prisma.user.findUnique({ where: { id: userId } }),
      ).resolves.toBeNull();
      await expect(prisma.session.count({ where: { userId } })).resolves.toBe(
        0,
      );
      await expect(
        prisma.authIdentity.count({ where: { userId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.rewardWallet.count({ where: { userId } }),
      ).resolves.toBe(0);
    });
  });
});
