/**
 * PHASE 10B — the WhatsApp OTP delivery PORT. The one boundary behind which
 * a messaging vendor lives, mirroring `MIDTRANS_GATEWAY` /
 * `GOOGLE_IDENTITY_VERIFIER` exactly.
 *
 * `AuthIdentityService` owns every security-relevant decision about an OTP —
 * generating it, hashing it, expiring it, counting attempts, consuming it
 * atomically — and a provider owns exactly one thing: DELIVERY. That split
 * is what "do not tightly couple AuthService to one vendor" means in
 * practice: swapping WhatsApp Cloud API for Twilio, Vonage, or an on-prem
 * gateway changes one class implementing this interface and nothing else,
 * and no vendor can ever influence how long a code lives or how many
 * guesses it tolerates.
 *
 * IMPLEMENTATIONS THAT EXIST TODAY:
 * - `DisabledWhatsAppOtpProvider` — the inert default, rejects everything
 *   with `WHATSAPP_AUTH_DISABLED`. Bound whenever the feature flag is off.
 * - `LocalFakeWhatsAppOtpProvider` — records codes in memory and delivers
 *   NOTHING. Constructible ONLY in `development`/`test` (see that class and
 *   `env.validation.ts`'s `validateWhatsAppConfig`).
 *
 * NO REAL VENDOR CLIENT SHIPS IN THIS WORK UNIT, because no vendor
 * credentials exist to build or test one against. That is stated plainly
 * rather than papered over with an untested HTTP client: an unexercised
 * vendor client would be indistinguishable from a working one until the
 * first production message silently failed to send.
 */

export interface SendWhatsAppOtpInput {
  /** Normalized E.164 destination — never a raw, user-typed string. */
  phoneE164: string;
  /**
   * The PLAINTEXT code, held only for the duration of this call. It is
   * never persisted anywhere (only its keyed hash is) and must never be
   * logged by an implementation — see `LocalFakeWhatsAppOtpProvider` for
   * the only in-repo place it is deliberately retained, and why that is
   * impossible outside development/test.
   */
  code: string;
  /** Remaining validity, for the message body ("expires in N minutes"). */
  expiresInSeconds: number;
}

export interface WhatsAppOtpProvider {
  /**
   * Delivers `code` to `phoneE164`. Resolves on successful hand-off to the
   * provider; rejects if delivery could not be initiated.
   *
   * A rejection here MUST NOT be reported to the caller as an OTP failure:
   * `AuthIdentityService.requestOtp` answers `202` regardless (its frozen
   * anti-enumeration contract), and a delivery fault is an operator
   * problem, logged server-side.
   */
  sendOtp(input: SendWhatsAppOtpInput): Promise<void>;
}

/** DI token, following the `TRANSCODE_QUEUE`/`MIDTRANS_GATEWAY` convention. */
export const WHATSAPP_OTP_PROVIDER = 'AUTH_WHATSAPP_OTP_PROVIDER';

/**
 * The CLOSED set of values `WHATSAPP_OTP_PROVIDER_DRIVER` accepts.
 *
 * `fake` is the only implemented driver, and it is refused outside
 * `development`/`test` by `env.validation.ts`. There is deliberately no
 * `"none"`/`"auto"` fallback: enabling WhatsApp auth without naming a
 * driver that actually exists must fail the BOOT, not degrade quietly into
 * an inert provider that answers `202` to every request while delivering
 * nothing — a backend that appears to send OTPs and does not is strictly
 * worse than one that refuses to start.
 */
export const WHATSAPP_OTP_DRIVERS = ['fake'] as const;

export type WhatsAppOtpDriver = (typeof WHATSAPP_OTP_DRIVERS)[number];
