import { IdentityProvidersConfig } from '../../../config/configuration';
import { WhatsAppCloudApiOtpProvider } from './whatsapp-cloud-api.provider';
import { DisabledWhatsAppOtpProvider } from './whatsapp-disabled.provider';
import { LocalFakeWhatsAppOtpProvider } from './whatsapp-local-fake.provider';
import { createWhatsAppOtpProvider } from './whatsapp-provider.factory';

/**
 * WHATSAPP LOGIN V1 — the binding decision.
 *
 * This branch had no test before this work unit, because it lived as an
 * inline closure inside `AuthModule`'s `useFactory`. It decides whether a
 * production deployment gets a real sender or an inert one that 503s every
 * login, and whether a provider holding PLAINTEXT OTP CODES can be
 * constructed — so it is worth asserting directly rather than inferring from
 * a booted container.
 */

const BASE: IdentityProvidersConfig = {
  googleEnabled: false,
  googleClientIds: [],
  whatsappEnabled: false,
  whatsappOtpDriver: undefined,
  whatsappCloudApiPhoneNumberId: undefined,
  whatsappCloudApiAccessToken: undefined,
  whatsappCloudApiTemplateName: undefined,
  whatsappCloudApiTemplateLanguage: undefined,
  whatsappCloudApiGraphVersion: undefined,
  whatsappCloudApiTemplateHasOtpButton: true,
};

const CLOUD_API: IdentityProvidersConfig = {
  ...BASE,
  whatsappEnabled: true,
  whatsappOtpDriver: 'cloud-api',
  whatsappCloudApiPhoneNumberId: '111122223333444',
  whatsappCloudApiAccessToken: 'spec-fixture-token',
  whatsappCloudApiTemplateName: 'red_panda_login_otp',
  whatsappCloudApiTemplateLanguage: 'id',
};

describe('createWhatsAppOtpProvider', () => {
  describe('the feature flag decides first', () => {
    it.each(['production', 'development', 'test', undefined])(
      'binds the INERT provider when WhatsApp auth is off (NODE_ENV=%s)',
      (nodeEnv) => {
        expect(createWhatsAppOtpProvider(BASE, nodeEnv)).toBeInstanceOf(
          DisabledWhatsAppOtpProvider,
        );
      },
    );

    it('binds the inert provider even when cloud-api is fully configured but disabled', () => {
      expect(
        createWhatsAppOtpProvider(
          { ...CLOUD_API, whatsappEnabled: false },
          'production',
        ),
      ).toBeInstanceOf(DisabledWhatsAppOtpProvider);
    });
  });

  describe('the cloud-api driver', () => {
    it.each(['production', 'development', 'test'])(
      'binds the REAL Cloud API provider under NODE_ENV=%s',
      (nodeEnv) => {
        expect(createWhatsAppOtpProvider(CLOUD_API, nodeEnv)).toBeInstanceOf(
          WhatsAppCloudApiOtpProvider,
        );
      },
    );

    it.each([
      'whatsappCloudApiPhoneNumberId',
      'whatsappCloudApiAccessToken',
      'whatsappCloudApiTemplateName',
      'whatsappCloudApiTemplateLanguage',
    ] as const)(
      'CRITICAL: THROWS rather than binding a half-configured sender (%s missing)',
      (key) => {
        // Failing at boot is the point: the alternative is a running server
        // that accepts OTP requests and delivers nothing.
        expect(() =>
          createWhatsAppOtpProvider(
            { ...CLOUD_API, [key]: undefined },
            'production',
          ),
        ).toThrow(/Refusing to construct WhatsAppCloudApiOtpProvider/);
      },
    );
  });

  describe('the fake driver is fenced to development/test', () => {
    const FAKE: IdentityProvidersConfig = {
      ...BASE,
      whatsappEnabled: true,
      whatsappOtpDriver: 'fake',
    };

    it.each(['development', 'test'])(
      'binds the local fake provider under NODE_ENV=%s',
      (nodeEnv) => {
        expect(createWhatsAppOtpProvider(FAKE, nodeEnv)).toBeInstanceOf(
          LocalFakeWhatsAppOtpProvider,
        );
      },
    );

    it.each([
      'production',
      'Production',
      'PRODUCTION',
      'staging',
      '',
      undefined,
    ])(
      'CRITICAL: refuses the fake provider under NODE_ENV=%s, binding the inert one',
      (nodeEnv) => {
        // A fail-closed ALLOWLIST, not a `!== production` denylist: an unset,
        // empty or differently-cased NODE_ENV must count as unsafe.
        expect(createWhatsAppOtpProvider(FAKE, nodeEnv)).toBeInstanceOf(
          DisabledWhatsAppOtpProvider,
        );
      },
    );
  });

  describe('the fail-closed floor', () => {
    it.each(['twilio', 'vonage', '', 'CLOUD-API', undefined])(
      'binds the INERT provider for an unrecognized driver "%s"',
      (driver) => {
        // `env.validation.ts` refuses to boot for each of these, so this
        // branch is unreachable in practice — but a default that is only
        // correct when validation ran is not a fail-closed default.
        expect(
          createWhatsAppOtpProvider(
            { ...BASE, whatsappEnabled: true, whatsappOtpDriver: driver },
            'production',
          ),
        ).toBeInstanceOf(DisabledWhatsAppOtpProvider);
      },
    );

    it('the inert provider rejects every send rather than pretending to deliver', async () => {
      const provider = createWhatsAppOtpProvider(BASE, 'production');

      await expect(
        provider.sendOtp({
          phoneE164: '+6281234567890',
          code: '123456',
          expiresInSeconds: 300,
        }),
      ).rejects.toMatchObject({ code: 'WHATSAPP_AUTH_DISABLED' });
    });
  });
});
