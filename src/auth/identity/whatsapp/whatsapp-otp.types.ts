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
 * - `WhatsAppCloudApiOtpProvider` — the PRODUCTION driver, speaking Meta's
 *   documented WhatsApp Cloud API `POST /{version}/{phone-number-id}/messages`
 *   contract. Bound for `WHATSAPP_OTP_PROVIDER_DRIVER=cloud-api`.
 * - `LocalFakeWhatsAppOtpProvider` — records codes in memory and delivers
 *   NOTHING. Constructible ONLY in `development`/`test` (see that class and
 *   `env.validation.ts`'s `validateWhatsAppConfig`).
 * - `DisabledWhatsAppOtpProvider` — the inert default, rejects everything
 *   with `WHATSAPP_AUTH_DISABLED`. Bound whenever the feature flag is off.
 *
 * WHAT IS AND IS NOT PROVEN. The Cloud API client is written against Meta's
 * PUBLISHED contract and is exercised end to end against a mocked transport
 * (`whatsapp-cloud-api.provider.spec.ts`) — request URL, headers, body
 * shape, every documented failure mode. It has NOT been exercised against a
 * live WhatsApp Business Account, because this project holds no Meta
 * credentials; no message has ever been sent by this code to any real
 * number. That distinction is stated here rather than left to be discovered:
 * the first real send is an OPERATOR step (see
 * `docs/WHATSAPP_LOGIN_SETUP.md`), and nothing in this repository can or
 * should claim it has happened.
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
   * Delivers `code` to `phoneE164`. Resolves ONLY when the provider has
   * accepted the message for delivery; rejects otherwise.
   *
   * RESOLVING MEANS "ACCEPTED", NOT "READ". No messaging network can tell a
   * sender synchronously that a human received a message, so an
   * implementation must resolve on a confirmed hand-off and never on
   * anything weaker — in particular never on a 2xx whose body does not
   * actually acknowledge the message (see `WhatsAppCloudApiOtpProvider`,
   * which treats an unrecognized success body as a failure rather than as
   * success).
   *
   * A rejection SHOULD be a `WhatsAppDeliveryError` so the caller can tell
   * the two consequences apart — see that class. Any other rejection is
   * treated by `WhatsAppOtpService` as `provider_unavailable`, i.e. the
   * loud, fail-closed reading: an implementation that throws something
   * unclassified has failed in a way nobody has reasoned about, and
   * silently answering "code sent" would be the one unacceptable response.
   */
  sendOtp(input: SendWhatsAppOtpInput): Promise<void>;
}

/**
 * How a delivery failure must be ANSWERED — the only distinction the OTP
 * service draws, and deliberately not a vendor error taxonomy.
 *
 * The split is NUMBER-INDEPENDENT vs NUMBER-SPECIFIC, because that is
 * exactly what decides whether surfacing the failure to an unauthenticated
 * caller can leak anything:
 *
 * - `provider_unavailable` — the send failed for a reason that has nothing
 *   to do with WHICH number was targeted: a timeout, a transport error, a
 *   5xx, an expired access token, a template that does not exist or is
 *   paused, a provider-side rate limit. The same request for ANY number
 *   fails identically, so the answer carries zero information about this
 *   number, this account, or this user — and it is therefore SAFE to
 *   surface, which `AuthIdentityService.requestOtp` does as
 *   `503 WHATSAPP_PROVIDER_UNAVAILABLE`. It is also NECESSARY to surface:
 *   the alternative is answering `202` to a user who will never receive a
 *   message, on a login screen that then has nothing to say to them.
 *
 * - `recipient_rejected` — the provider refused THIS destination
 *   specifically (e.g. the number is not reachable on WhatsApp). Answering
 *   differently here WOULD be a per-number oracle, so it is deliberately
 *   NOT surfaced: the caller still receives the ordinary `202`, and the
 *   challenge is left live so the response is byte-identical to a
 *   successful send. The operator sees it in the log.
 *
 * WHEN A CLASSIFICATION IS UNCERTAIN, an implementation MUST choose
 * `provider_unavailable`. Mis-classifying an operator outage as a recipient
 * problem hides a total login outage behind a stream of cheerful `202`s;
 * mis-classifying a recipient problem as an outage costs one honest 503.
 */
export type WhatsAppDeliveryFailureKind =
  'provider_unavailable' | 'recipient_rejected';

/**
 * The one error type a `WhatsAppOtpProvider` throws. Its `message` is
 * written by the implementation and is assumed to reach a log, so it must
 * NEVER carry the OTP code, the full destination number, an access token,
 * or a raw provider response body.
 */
export class WhatsAppDeliveryError extends Error {
  constructor(
    readonly kind: WhatsAppDeliveryFailureKind,
    message: string,
    /** Provider HTTP status, when there was one. Diagnostic only. */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'WhatsAppDeliveryError';
  }
}

/** DI token, following the `TRANSCODE_QUEUE`/`MIDTRANS_GATEWAY` convention. */
export const WHATSAPP_OTP_PROVIDER = 'AUTH_WHATSAPP_OTP_PROVIDER';

/**
 * The CLOSED set of values `WHATSAPP_OTP_PROVIDER_DRIVER` accepts.
 *
 * - `cloud-api` — Meta's WhatsApp Cloud API. THE PRODUCTION DRIVER, and the
 *   only one that ever sends a message.
 * - `fake` — in-memory, sends nothing, refused outside `development`/`test`
 *   by `env.validation.ts` AND by its own constructor.
 *
 * There is deliberately no `"none"`/`"auto"` fallback and no default:
 * enabling WhatsApp auth without naming a driver that actually exists must
 * fail the BOOT, not degrade quietly into an inert provider that answers
 * `202` to every request while delivering nothing — a backend that appears
 * to send OTPs and does not is strictly worse than one that refuses to
 * start.
 */
export const WHATSAPP_OTP_DRIVERS = ['cloud-api', 'fake'] as const;

export type WhatsAppOtpDriver = (typeof WHATSAPP_OTP_DRIVERS)[number];

/**
 * The drivers that actually deliver a message, i.e. the ones a PRODUCTION
 * deployment may name. Kept as its own list rather than "everything except
 * `fake`" so that adding a second non-delivering driver later cannot
 * silently become production-eligible by omission.
 */
export const PRODUCTION_WHATSAPP_OTP_DRIVERS = ['cloud-api'] as const;

export function isProductionWhatsAppOtpDriver(value: string): boolean {
  return (PRODUCTION_WHATSAPP_OTP_DRIVERS as readonly string[]).includes(value);
}
