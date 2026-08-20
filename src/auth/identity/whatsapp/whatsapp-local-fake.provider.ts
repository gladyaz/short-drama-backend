import { Logger } from '@nestjs/common';
import {
  SendWhatsAppOtpInput,
  WhatsAppOtpProvider,
} from './whatsapp-otp.types';

/**
 * PHASE 10B — a strictly LOCAL, NON-DELIVERING WhatsApp OTP provider.
 *
 * WHAT IT IS FOR: exercising the complete OTP lifecycle — request, deliver,
 * verify, expire, exhaust attempts, cool down, link, sign in — end to end
 * against real database rows and the real HTTP stack, without any vendor
 * account. Every OTP test in this repository runs through this class, so
 * the code paths under test are the production ones; only the final
 * "hand the code to a messaging network" step is replaced.
 *
 * WHAT IT IS NOT: evidence that WhatsApp delivery works. NO MESSAGE IS EVER
 * SENT by this class, to any number, ever. No real WhatsApp delivery has
 * been tested in this work unit, because no provider credentials exist.
 *
 * ================= WHY IT CANNOT EXIST IN PRODUCTION =================
 *
 * This provider retains the PLAINTEXT code in memory so a test can read it
 * back. That is exactly the property that would make it catastrophic
 * outside development — so it is fenced off by FOUR independent gates, any
 * one of which is sufficient, arranged so that no single mistake enables it:
 *
 *   1. BOOT-TIME ALLOWLIST — `env.validation.ts`'s `validateWhatsAppConfig`
 *      refuses to start the process when `WHATSAPP_OTP_PROVIDER_DRIVER` is
 *      `fake` and `NODE_ENV` is not exactly `development` or `test`. It is
 *      an allowlist, not a `!== 'production'` denylist: an unset, empty,
 *      misspelled or differently-cased `NODE_ENV` is treated as UNSAFE
 *      (the shape `validateDevToolsNodeEnv` established after that exact
 *      class of bug was escalated to HIGH in a prior review).
 *   2. MODULE FACTORY — `AuthModule` binds this class only for the `fake`
 *      driver, and only when the same `NODE_ENV` allowlist holds.
 *   3. CONSTRUCTOR — the check below, which throws if it is ever
 *      constructed outside that allowlist. This catches a direct `new` in
 *      code that bypassed both checks above.
 *   4. RESPONSE EXPOSURE — the plaintext code reaches an API response only
 *      through `POST /auth/whatsapp/otp/request`'s `devCode` field, which
 *      additionally requires `DEV_TOOLS_ENABLED=true` (the existing
 *      `PasswordResetRequestResponseDto.devToken` precedent, reused rather
 *      than reinvented).
 *
 * The code is deliberately NOT written to the application log at any level.
 * Logging it would satisfy "convenient in dev" while creating precisely the
 * artifact ("no OTP in production logs") this design must never produce —
 * and log destinations are far easier to misconfigure than process
 * environments.
 */
export const FAKE_WHATSAPP_ALLOWED_NODE_ENVS = ['development', 'test'] as const;

export function isFakeWhatsAppProviderAllowed(
  nodeEnv: string | undefined,
): boolean {
  return (FAKE_WHATSAPP_ALLOWED_NODE_ENVS as readonly string[]).includes(
    nodeEnv ?? '',
  );
}

export class LocalFakeWhatsAppOtpProvider implements WhatsAppOtpProvider {
  private readonly logger = new Logger(LocalFakeWhatsAppOtpProvider.name);

  /**
   * Last code issued per E.164 number. Bounded by `MAX_TRACKED_NUMBERS` so a
   * long-running dev server cannot grow it without limit; entries are
   * evicted oldest-first. Never persisted, never serialized, gone on
   * restart.
   */
  private readonly lastCodes = new Map<string, string>();

  static readonly MAX_TRACKED_NUMBERS = 100;

  constructor(nodeEnv: string | undefined) {
    if (!isFakeWhatsAppProviderAllowed(nodeEnv)) {
      throw new Error(
        'Refusing to construct LocalFakeWhatsAppOtpProvider: NODE_ENV is not exactly "development" or "test". ' +
          'This provider retains plaintext OTP codes in memory and must never exist outside local development or tests.',
      );
    }
  }

  sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
    if (
      this.lastCodes.size >= LocalFakeWhatsAppOtpProvider.MAX_TRACKED_NUMBERS
    ) {
      const oldest = this.lastCodes.keys().next();
      if (!oldest.done) {
        this.lastCodes.delete(oldest.value);
      }
    }

    // Re-inserting moves the key to the end of the Map's insertion order,
    // which is what makes the eviction above least-recently-issued.
    this.lastCodes.delete(input.phoneE164);
    this.lastCodes.set(input.phoneE164, input.code);

    // Note what happened, but NEVER the code and NEVER the full number —
    // this line is the one thing about this class that could plausibly end
    // up in a shared log file. `maskPhoneE164` is not used here to avoid a
    // dependency from a provider onto the normalization utility; the last
    // four digits are computed inline.
    this.logger.debug(
      `Fake WhatsApp OTP issued for ...${input.phoneE164.slice(-4)} (no message sent)`,
    );

    return Promise.resolve();
  }

  /**
   * The most recent code issued for `phoneE164`, or `undefined`. The ONLY
   * way a test reads a code back — every test obtains it from this method
   * (or from the `devCode` response field), never by reaching into the
   * database, so the tests exercise the same "the user read the message"
   * step a real client performs.
   */
  lastCodeFor(phoneE164: string): string | undefined {
    return this.lastCodes.get(phoneE164);
  }

  /** Clears retained codes — used by test teardown. */
  reset(): void {
    this.lastCodes.clear();
  }
}
