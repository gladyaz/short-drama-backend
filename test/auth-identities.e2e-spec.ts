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
import type { AuthIdentitySummaryDto } from './../src/auth/identity/auth-identity.types';
import { GOOGLE_IDENTITY_VERIFIER } from './../src/auth/identity/google/google-identity.types';
import type {
  GoogleIdentityVerifier,
  GoogleVerifiedIdentity,
} from './../src/auth/identity/google/google-identity.types';
import { GoogleTokenRejected } from './../src/auth/identity/google/google-id-token.util';
import { WHATSAPP_OTP_PROVIDER } from './../src/auth/identity/whatsapp/whatsapp-otp.types';
import { LocalFakeWhatsAppOtpProvider } from './../src/auth/identity/whatsapp/whatsapp-local-fake.provider';
import { WhatsAppOtpService } from './../src/auth/identity/whatsapp/whatsapp-otp.service';
import {
  OTP_MAX_ATTEMPTS,
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
 * PHASE 10B e2e — the identity routes over the REAL HTTP stack: routing, the
 * global `ValidationPipe`, `AppExceptionFilter`, per-route `@Throttle()`
 * overrides, `JwtAuthGuard`, and real database rows.
 *
 * TWO SUBSTITUTIONS, BOTH AT PRODUCTION'S OWN DI SEAMS:
 *   - `GOOGLE_IDENTITY_VERIFIER` is scripted, so this suite never reaches
 *     Google. The real cryptographic verification is covered against real
 *     RSA keys in `google-oidc.verifier.spec.ts`.
 *   - `WHATSAPP_OTP_PROVIDER` is the REAL `LocalFakeWhatsAppOtpProvider` —
 *     the same class production would bind in a development environment,
 *     not a bespoke test double — so the OTP round trip exercised here is
 *     the genuine one, right down to how a test reads the code back.
 *
 * NO REAL WHATSAPP MESSAGE IS SENT BY THIS SUITE, OR BY ANY CODE IN THIS
 * REPOSITORY. `LocalFakeWhatsAppOtpProvider` delivers nothing, anywhere.
 */
jest.setTimeout(bcryptTestBudgetMs(8));

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

describe('Auth identities (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let throttlerStorage: ThrottlerStorageService;
  let google: ScriptedGoogleVerifier;
  let fakeOtpProvider: LocalFakeWhatsAppOtpProvider;

  const emailPrefix = TEST_FIXTURE_NAMESPACE;
  const uniqueEmail = (label: string): string => fixtureEmail(`aie-${label}`);
  const uniqueSubject = (label: string): string =>
    `${TEST_FIXTURE_NAMESPACE}-g-${label}`;

  beforeAll(async () => {
    google = new ScriptedGoogleVerifier();
    // Constructed with an explicit `'test'` rather than reading `NODE_ENV`,
    // so this line also documents the class's own refusal to exist outside
    // development/test — passing anything else here throws.
    fakeOtpProvider = new LocalFakeWhatsAppOtpProvider('test');

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

    // The identity feature flags are OFF by default in this repository (see
    // `.env.example`), so a boot from real config would answer 503 to every
    // route under test. `ConfigService` is not stubbed wholesale — that
    // would bypass the very wiring this suite exists to exercise — so the
    // flags are flipped on the resolved config object the app already holds.
    const identityConfig = moduleFixture
      .get<ConfigService<RootConfig>>(ConfigService)
      .get('identityProviders', { infer: true })!;
    identityConfig.googleEnabled = true;
    identityConfig.whatsappEnabled = true;
  });

  beforeEach(() => {
    // Every route under test carries a tight per-route `@Throttle()`
    // override, and this suite shares one app instance (and therefore one
    // in-memory throttler store) across many tests that each legitimately
    // call them. Clearing between tests keeps the FUNCTIONAL assertions
    // isolated from the rate limits; the limits themselves are asserted
    // explicitly in their own test below, which does its own counting.
    resetThrottlerStorage(throttlerStorage);
    fakeOtpProvider.reset();
  });

  afterAll(async () => {
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

  async function registerAccount(label: string): Promise<{
    email: string;
    auth: AuthResponseDto;
  }> {
    const email = uniqueEmail(label);
    const response = await request(server())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);
    return { email, auth: response.body as AuthResponseDto };
  }

  async function completeOtp(phone: string): Promise<string> {
    await request(server())
      .post('/auth/whatsapp/otp/request')
      .send({ phone })
      .expect(HttpStatus.ACCEPTED);
    const code = fakeOtpProvider.lastCodeFor(phone);
    if (!code) {
      throw new Error(`fake provider recorded no code for ${phone}`);
    }
    return code;
  }

  describe('POST /auth/google', () => {
    it('signs up a new Google user and returns the standard token pair', async () => {
      const email = uniqueEmail('g-signup');
      google.grant('e2e-tok-signup', {
        subject: uniqueSubject('signup'),
        email,
        displayName: 'E2E Google User',
      });

      const response = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-signup' })
        .expect(HttpStatus.OK);

      const body = response.body as AuthResponseDto;
      expect(body.user.email).toBe(email);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      // No credential material, and no provider identifier, in the response.
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|\$2[aby]\$/);
      expect(JSON.stringify(body)).not.toContain(uniqueSubject('signup'));
    });

    it('signs a returning Google user into the same account', async () => {
      google.grant('e2e-tok-return', { subject: uniqueSubject('return') });

      const first = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-return' })
        .expect(HttpStatus.OK);
      const second = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-return' })
        .expect(HttpStatus.OK);

      expect((second.body as AuthResponseDto).user.id).toBe(
        (first.body as AuthResponseDto).user.id,
      );
    });

    it('answers 401 INVALID_GOOGLE_TOKEN for an unverifiable token', async () => {
      const response = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-nonsense' })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_GOOGLE_TOKEN',
      );
    });

    it('rejects a body that tries to supply identity fields directly', async () => {
      // The whitelisting `ValidationPipe` is what stops a client from ever
      // hinting at an email or subject; only `idToken` is accepted.
      const response = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-nonsense', email: 'victim@example.com' })
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe('HTTP_ERROR');
    });

    it('answers 409 AUTH_ACCOUNT_LINK_REQUIRED on an email collision and creates nothing', async () => {
      const { email } = await registerAccount('collision');
      google.grant('e2e-tok-collision', {
        subject: uniqueSubject('collision'),
        email,
      });

      const response = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-collision' })
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'AUTH_ACCOUNT_LINK_REQUIRED',
      );
      expect(
        await prisma.authIdentity.count({
          where: { providerSubject: uniqueSubject('collision') },
        }),
      ).toBe(0);
    });
  });

  describe('WhatsApp OTP over HTTP', () => {
    it('completes a full request → verify → signed-in round trip', async () => {
      const phone = fixturePhone();

      const requested = await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone })
        .expect(HttpStatus.ACCEPTED);

      expect(requested.body).toMatchObject({ success: true });
      // PHASE 10C — the two timing fields are part of the frozen contract.
      // The client renders its expiry and resend countdowns from THESE
      // values; a missing one previously produced a NaN countdown that never
      // finished and a resend button that stayed disabled for the whole
      // session, so "present and correct" is asserted at the HTTP boundary
      // rather than trusted.
      expect(requested.body).toMatchObject({
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        resendAvailableInSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      });
      // `DEV_TOOLS_ENABLED` is not set in the test environment, so no
      // plaintext code may appear in the response body.
      expect(requested.body).not.toHaveProperty('devCode');

      const code = fakeOtpProvider.lastCodeFor(phone)!;
      const verified = await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone, code })
        .expect(HttpStatus.OK);

      const body = verified.body as AuthResponseDto;
      expect(body.user.email).toBeNull();
      expect(body.accessToken).toEqual(expect.any(String));

      // The issued access token works against a normal guarded route — the
      // proof that this is the SAME session system, not a parallel one.
      const me = await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(HttpStatus.OK);
      expect((me.body as { id: string }).id).toBe(body.user.id);
    });

    it('answers 401 INVALID_OTP for a wrong code and for an unknown number alike', async () => {
      const known = fixturePhone();
      await completeOtp(known);

      const wrongCode = await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone: known, code: '000000' })
        .expect(HttpStatus.UNAUTHORIZED);
      const unknownNumber = await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone: fixturePhone(), code: '000000' })
        .expect(HttpStatus.UNAUTHORIZED);

      // Identical responses: distinguishing them would make this endpoint a
      // phone-number enumeration oracle.
      expect((wrongCode.body as ErrorResponseBody).code).toBe('INVALID_OTP');
      expect(wrongCode.body).toEqual(unknownNumber.body);
    });

    it('answers 429 OTP_RESEND_COOLDOWN on an immediate resend for the same number', async () => {
      const phone = fixturePhone();
      await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone })
        .expect(HttpStatus.ACCEPTED);

      // Throttler storage is cleared per test, so this 429 comes from the
      // per-NUMBER database rule, not the per-IP limiter.
      resetThrottlerStorage(throttlerStorage);
      const response = await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone })
        .expect(HttpStatus.TOO_MANY_REQUESTS);

      expect((response.body as ErrorResponseBody).code).toBe(
        'OTP_RESEND_COOLDOWN',
      );
    });

    it('refuses the correct code once the attempt budget is exhausted', async () => {
      const phone = fixturePhone();
      const code = await completeOtp(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
        resetThrottlerStorage(throttlerStorage);
        await request(server())
          .post('/auth/whatsapp/otp/verify')
          .send({ phone, code: wrong })
          .expect(HttpStatus.UNAUTHORIZED);
      }

      resetThrottlerStorage(throttlerStorage);
      await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone, code })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('rejects a malformed phone number with 400 INVALID_PHONE_NUMBER', async () => {
      const response = await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone: '12345678901' })
        .expect(HttpStatus.BAD_REQUEST);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_PHONE_NUMBER',
      );
    });

    it('rate-limits OTP requests per IP', async () => {
      // Deliberately does NOT reset the throttler mid-loop: this test is
      // about the per-route override itself.
      const responses = [];
      for (let i = 0; i < 5; i += 1) {
        responses.push(
          await request(server())
            .post('/auth/whatsapp/otp/request')
            .send({ phone: fixturePhone() }),
        );
      }

      expect(
        responses.some((r) => r.status === HttpStatus.TOO_MANY_REQUESTS),
      ).toBe(true);
    });
  });

  describe('identity management routes', () => {
    it('requires authentication for every identity route', async () => {
      await request(server())
        .get('/auth/identities')
        .expect(HttpStatus.UNAUTHORIZED);
      await request(server())
        .post('/auth/identities/google/link')
        .send({ idToken: 'x' })
        .expect(HttpStatus.UNAUTHORIZED);
      await request(server())
        .delete('/auth/identities/google')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('lists the caller’s own identities without exposing provider subjects', async () => {
      const { email, auth } = await registerAccount('list');

      const response = await request(server())
        .get('/auth/identities')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);

      const identities = response.body as AuthIdentitySummaryDto[];
      expect(identities).toHaveLength(1);
      expect(identities[0]).toMatchObject({
        provider: 'email',
        identifier: email,
        usable: true,
        canBeUnlinked: false,
      });
    });

    it('links Google, then unlinks it, keeping the account signed in throughout', async () => {
      const { auth } = await registerAccount('link-unlink');
      google.grant('e2e-tok-link', { subject: uniqueSubject('link') });

      const linked = await request(server())
        .post('/auth/identities/google/link')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({ idToken: 'e2e-tok-link' })
        .expect(HttpStatus.OK);
      expect(
        (linked.body as AuthIdentitySummaryDto[]).map((i) => i.provider).sort(),
      ).toEqual(['email', 'google']);

      const unlinked = await request(server())
        .delete('/auth/identities/google')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);
      expect(
        (unlinked.body as AuthIdentitySummaryDto[]).map((i) => i.provider),
      ).toEqual(['email']);

      // The unlink did not revoke the caller's session — a documented,
      // deliberate property (`POST /auth/logout-all` is the tool for that).
      await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);
    });

    it('links WhatsApp with a real OTP and masks the number in the listing', async () => {
      const { auth } = await registerAccount('link-wa');
      const phone = fixturePhone();
      const code = await completeOtp(phone);

      const response = await request(server())
        .post('/auth/identities/whatsapp/link')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({ phone, code })
        .expect(HttpStatus.OK);

      const identities = response.body as AuthIdentitySummaryDto[];
      const whatsapp = identities.find((i) => i.provider === 'whatsapp');
      expect(whatsapp?.identifier).toMatch(/^\+\*+\d{4}$/);
      expect(JSON.stringify(identities)).not.toContain(phone);
    });

    it('refuses to remove the last usable authentication method with 409', async () => {
      google.grant('e2e-tok-only', { subject: uniqueSubject('only') });
      const signIn = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-only' })
        .expect(HttpStatus.OK);
      const { accessToken } = signIn.body as AuthResponseDto;

      const response = await request(server())
        .delete('/auth/identities/google')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CONFLICT);

      expect((response.body as ErrorResponseBody).code).toBe(
        'AUTH_LAST_IDENTITY',
      );
    });

    it('rejects an unroutable provider segment with 400', async () => {
      const { auth } = await registerAccount('bad-provider');

      // `email` is deliberately not unlinkable through this route: it is
      // inseparable from `User.email`/`User.passwordHash`.
      await request(server())
        .delete('/auth/identities/email')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.BAD_REQUEST);
      await request(server())
        .delete('/auth/identities/facebook')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  /**
   * PHASE 10C — the reconciled contract's three cross-provider guarantees,
   * asserted at the real HTTP boundary because they are exactly the ones a
   * client depends on and a unit test cannot observe: what the canonical
   * email routes may NOT do, what a phone-only account's JSON actually looks
   * like, and that OTP-start cannot be used to probe for accounts.
   */
  describe('canonical contract guarantees', () => {
    it('LOGIN NEVER REGISTERS: an unknown email is 401 and creates no row', async () => {
      const email = uniqueEmail('login-never-registers');

      const before = await prisma.user.count({ where: { email } });
      expect(before).toBe(0);

      const response = await request(server())
        .post('/auth/login')
        .send({ email, password: 'correct-horse-battery' })
        .expect(HttpStatus.UNAUTHORIZED);

      expect((response.body as ErrorResponseBody).code).toBe(
        'INVALID_CREDENTIALS',
      );
      // The load-bearing assertion. `INVALID_CREDENTIALS` alone would still
      // be satisfied by an implementation that created the account and then
      // failed the password check, so the row count is what actually pins
      // "account creation is EXPLICIT, and only `POST /auth/register` does
      // it". The mobile client removed its own login-or-register fallback
      // for the same reason; this is the server-side half of that contract.
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('a phone-only account reports email: null — never a synthetic address', async () => {
      const phone = fixturePhone();
      const code = await completeOtp(phone);

      const verified = await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone, code })
        .expect(HttpStatus.OK);
      const session = verified.body as AuthResponseDto;

      // PRESENT, and null — not omitted. A client may read `user.email`
      // unconditionally; what it must not assume is that it is a string.
      expect(session.user).toHaveProperty('email', null);

      const me = await request(server())
        .get('/auth/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(HttpStatus.OK);
      expect(me.body).toHaveProperty('email', null);

      // No invented address anywhere in the account's own records: the human
      // -readable label for this account comes from the MASKED identifier on
      // the identity listing, which is why that listing exists.
      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: session.user.id },
        select: { email: true },
      });
      expect(stored.email).toBeNull();

      const identities = await request(server())
        .get('/auth/identities')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(HttpStatus.OK);
      const listed = identities.body as AuthIdentitySummaryDto[];
      expect(listed).toHaveLength(1);
      expect(listed[0].provider).toBe('whatsapp');
      expect(listed[0].identifier).not.toContain('@');
      expect(listed[0].identifier).not.toBe(phone);
    });

    it('OTP-start answers identically for a number with an account and one without', async () => {
      const registered = fixturePhone();
      const code = await completeOtp(registered);
      await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone: registered, code })
        .expect(HttpStatus.OK);

      // BACK-DATES the challenge rather than deleting it, which matters.
      // Clearing the cooldown is necessary — leaving it in force would mask
      // the comparison behind a 429 that has nothing to do with account
      // existence — but DELETING the row would also erase this number's
      // request history, and then a hypothetical implementation that
      // derived its timing from that history would produce identical bodies
      // for both numbers and pass this test vacuously. Back-dating leaves
      // `registered` with one real prior challenge and the fresh number with
      // none, so the comparison below discriminates a fixed constant from a
      // history-derived value as well as an account-existence leak.
      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: registered },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      resetThrottlerStorage(throttlerStorage);

      const knownNumber = await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone: registered })
        .expect(HttpStatus.ACCEPTED);

      const unknownNumber = await request(server())
        .post('/auth/whatsapp/otp/request')
        .send({ phone: fixturePhone() })
        .expect(HttpStatus.ACCEPTED);

      // Deep-equal bodies AND identical status. Both timing fields are
      // fixed public constants precisely so this equality holds — a
      // remaining-cooldown value would make the response vary by the
      // number's recent history, which the back-dated row above now makes
      // observable. What this cannot see is response TIMING; that side
      // channel is closed by construction instead, because `requestOtp`
      // never reads `User` or `AuthIdentity` at all.
      expect(knownNumber.body).toEqual(unknownNumber.body);
      expect(knownNumber.body).toMatchObject({
        success: true,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        resendAvailableInSeconds: Math.floor(OTP_RESEND_COOLDOWN_MS / 1000),
      });
    });
  });

  describe('session unification', () => {
    it('a Google-issued refresh token rotates and revokes through the standard routes', async () => {
      google.grant('e2e-tok-session', { subject: uniqueSubject('session') });
      const signIn = await request(server())
        .post('/auth/google')
        .send({ idToken: 'e2e-tok-session' })
        .expect(HttpStatus.OK);
      const { refreshToken } = signIn.body as AuthResponseDto;

      const refreshed = await request(server())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.OK);
      const rotated = (refreshed.body as AuthResponseDto).refreshToken;
      expect(rotated).not.toBe(refreshToken);

      // Reuse detection is the pre-existing hardened behaviour, applied to a
      // social session with no special-casing.
      const reuse = await request(server())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);
      expect((reuse.body as ErrorResponseBody).code).toBe(
        'INVALID_REFRESH_TOKEN',
      );

      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: rotated })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('the sessions list shows a WhatsApp-issued session like any other', async () => {
      const phone = fixturePhone();
      const code = await completeOtp(phone);
      const verified = await request(server())
        .post('/auth/whatsapp/otp/verify')
        .send({ phone, code })
        .expect(HttpStatus.OK);
      const { accessToken } = verified.body as AuthResponseDto;

      const sessions = await request(server())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect((sessions.body as unknown[]).length).toBe(1);
      expect(JSON.stringify(sessions.body)).not.toMatch(
        /refreshTokenHash|ipHash/,
      );
    });

    it('the personal-data export reports the linked identities, including the full phone number', async () => {
      // The export is the one place the FULL number belongs: its purpose is
      // telling the account owner exactly what is stored about them.
      const { auth } = await registerAccount('export');
      const phone = fixturePhone();
      const code = await completeOtp(phone);
      await request(server())
        .post('/auth/identities/whatsapp/link')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({ phone, code })
        .expect(HttpStatus.OK);

      const response = await request(server())
        .get('/users/me/export')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as {
        profile: {
          authIdentities: { provider: string; identifier: string | null }[];
        };
      };
      expect(body.profile.authIdentities.map((i) => i.provider).sort()).toEqual(
        ['email', 'whatsapp'],
      );
      expect(
        body.profile.authIdentities.find((i) => i.provider === 'whatsapp')
          ?.identifier,
      ).toBe(phone);
    });
  });

  describe('WhatsAppOtpService wiring', () => {
    it('reports the bound provider as the local fake in this test environment', () => {
      const otpService = app.get(WhatsAppOtpService);

      expect(otpService.localFakeProvider).toBe(fakeOtpProvider);
    });
  });
});
