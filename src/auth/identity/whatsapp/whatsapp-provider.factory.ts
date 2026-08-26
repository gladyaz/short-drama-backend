import { IdentityProvidersConfig } from '../../../config/configuration';
import { WhatsAppCloudApiOtpProvider } from './whatsapp-cloud-api.provider';
import { DisabledWhatsAppOtpProvider } from './whatsapp-disabled.provider';
import {
  isFakeWhatsAppProviderAllowed,
  LocalFakeWhatsAppOtpProvider,
} from './whatsapp-local-fake.provider';
import { WhatsAppOtpProvider } from './whatsapp-otp.types';

/**
 * WHATSAPP LOGIN V1 — the one decision that turns configuration into a
 * delivery provider.
 *
 * EXTRACTED FROM `AuthModule`'S `useFactory` so it can be tested directly.
 * It was previously an inline closure, which meant the single most
 * consequential branch in the feature — "does a production deployment get a
 * real sender, or an inert one that 503s every login?" — had no test that
 * could reach it without booting the entire Nest container. A wrong answer
 * here is invisible until a user tries to sign in.
 *
 * ============================ FAIL-CLOSED ORDER ============================
 *
 * The branches are ordered so that every path NOT explicitly recognized ends
 * at `DisabledWhatsAppOtpProvider`, which rejects every send. That is the
 * only safe floor: an inert provider produces a truthful `503
 * WHATSAPP_AUTH_DISABLED`, whereas any "best effort" fallback would produce
 * a backend that accepts OTP requests and delivers nothing.
 *
 * `env.validation.ts` has already refused to boot for every configuration
 * that reaches that floor with the flag on, so in practice the floor is
 * unreachable. It is kept anyway, and asserted by the spec, because a
 * fail-closed default that is only correct when validation ran is not
 * fail-closed at all — a test harness constructing the module directly, or a
 * future refactor of `validateEnv`, is exactly the case it exists for.
 */
export function createWhatsAppOtpProvider(
  identity: IdentityProvidersConfig,
  nodeEnv: string | undefined,
): WhatsAppOtpProvider {
  if (!identity.whatsappEnabled) {
    return new DisabledWhatsAppOtpProvider();
  }

  // THE PRODUCTION DRIVER. Its own constructor refuses if any of the four
  // required settings is blank, so a half-configured deployment fails at
  // BOOT rather than at the first user's login attempt. `env.validation.ts`
  // has already required the same four by name; this is the second of two
  // independent checks, not the only one.
  if (identity.whatsappOtpDriver === 'cloud-api') {
    return new WhatsAppCloudApiOtpProvider({
      phoneNumberId: identity.whatsappCloudApiPhoneNumberId ?? '',
      accessToken: identity.whatsappCloudApiAccessToken ?? '',
      templateName: identity.whatsappCloudApiTemplateName ?? '',
      templateLanguage: identity.whatsappCloudApiTemplateLanguage ?? '',
      graphVersion: identity.whatsappCloudApiGraphVersion,
      templateHasOtpButton: identity.whatsappCloudApiTemplateHasOtpButton,
    });
  }

  // The `NODE_ENV` allowlist is re-checked here even though
  // `env.validation.ts` enforces it at boot. That duplication is deliberate:
  // this is the last point before a provider that retains PLAINTEXT OTP
  // CODES IN MEMORY is constructed, and a fail-closed check at the point of
  // construction cannot be bypassed by a code path that skipped validation.
  // `LocalFakeWhatsAppOtpProvider`'s own constructor then refuses a third
  // time — see that class's doc comment for all four gates.
  if (
    identity.whatsappOtpDriver === 'fake' &&
    isFakeWhatsAppProviderAllowed(nodeEnv)
  ) {
    return new LocalFakeWhatsAppOtpProvider(nodeEnv);
  }

  return new DisabledWhatsAppOtpProvider();
}
