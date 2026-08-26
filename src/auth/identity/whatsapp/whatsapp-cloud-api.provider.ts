import { Logger } from '@nestjs/common';
import { redactSensitiveText } from '../../../common/logging/redact';
import {
  SendWhatsAppOtpInput,
  WhatsAppDeliveryError,
  WhatsAppOtpProvider,
} from './whatsapp-otp.types';

/**
 * WHATSAPP LOGIN V1 — the PRODUCTION OTP delivery driver, and the only file
 * in this codebase that speaks WhatsApp Cloud API HTTP.
 *
 * Shaped deliberately after `HttpMidtransClient` (`src/payments/midtrans/`),
 * which is this repository's established answer to "how do we talk to a
 * vendor": a hand-written client against the vendor's PUBLISHED HTTP
 * contract rather than an SDK, one transport choke point, a `fetchFn` seam
 * so every path is exercised by a spec without a network, and errors that
 * never carry the credential.
 *
 * ======================= THE CONTRACT IT IMPLEMENTS =======================
 *
 *   POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *   Authorization: Bearer {access-token}
 *   Content-Type: application/json
 *
 *   {
 *     "messaging_product": "whatsapp",
 *     "recipient_type": "individual",
 *     "to": "6281234567890",
 *     "type": "template",
 *     "template": {
 *       "name": "<template name>",
 *       "language": { "code": "<language code>" },
 *       "components": [
 *         { "type": "body",
 *           "parameters": [ { "type": "text", "text": "<code>" } ] },
 *         { "type": "button", "sub_type": "url", "index": "0",
 *           "parameters": [ { "type": "text", "text": "<code>" } ] }
 *       ]
 *     }
 *   }
 *
 * THE CODE APPEARS TWICE, and that is Meta's requirement rather than a
 * mistake: an AUTHENTICATION-category template must carry a one-time-password
 * button (copy-code or one-tap autofill), the body parameter fills the
 * message text, and the button parameter fills what the button copies or
 * autofills. Both variants take the identical `sub_type: "url"` send payload
 * — the copy-code/one-tap distinction is made when the template is CREATED,
 * not when a message is sent, which is why this client needs no setting to
 * tell them apart.
 *
 * `templateHasOtpButton` exists for the one case that genuinely differs: an
 * operator whose template is NOT authentication-category (a utility template
 * with no button). Sending a button component to such a template is rejected
 * by Meta, and omitting one from an authentication template is too — so this
 * is a real fork in the contract, not speculative generality, and it
 * defaults to `true` because an authentication template is what Meta
 * requires for OTP delivery in the first place.
 *
 * ============================ WHAT IT NEVER DOES ============================
 *
 * - It never logs the OTP code, and never the full destination number. Log
 *   lines carry the last four digits only, and pass through
 *   `redactSensitiveText` regardless.
 * - It never puts the access token in a thrown error or a log line. The
 *   token is captured once into `authorizationHeader` and read nowhere else.
 * - It never inspects, logs, or re-attaches the caught transport error: an
 *   undici error can embed the full request, whose `Authorization` header
 *   embeds the token. This is the `fetchSigned`/`HttpMidtransClient` house
 *   rule, and it is why the `catch` below is deliberately bare.
 * - It never echoes a provider response body. Bodies are read only to pull
 *   the documented `error.code` integer out, and are otherwise discarded.
 * - It never decides anything about the OTP itself. Generation, hashing,
 *   expiry, attempt budgets and single-use consumption all belong to
 *   `WhatsAppOtpService`; this class delivers a string and reports whether
 *   the network accepted it.
 */

/**
 * The Graph API version this client is written against, used when
 * `WHATSAPP_CLOUD_API_GRAPH_VERSION` is unset. PINNED rather than floating:
 * Meta versions this API precisely so that a client keeps getting the shape
 * it was written for, and silently following "latest" is how a working
 * integration breaks on somebody else's release schedule. An operator can
 * move it forward deliberately once they have re-read the changelog.
 */
export const DEFAULT_WHATSAPP_GRAPH_VERSION = 'v21.0';

/** Graph API host. A constant, not configuration — it is a fixed public fact. */
export const WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';

/**
 * Transport timeout for one send. An OTP request holds an unauthenticated
 * HTTP request open while it waits, so this bounds how long an attacker can
 * pin a request slot by targeting a slow path — the same reasoning behind
 * `GOOGLE_JWKS_FETCH_TIMEOUT_MS`. Ten seconds matches
 * `MIDTRANS_REQUEST_TIMEOUT_MS` and is far longer than a healthy Cloud API
 * send, which returns in well under a second.
 */
export const WHATSAPP_CLOUD_API_TIMEOUT_MS = 10_000;

/**
 * Documented Cloud API error codes that describe THIS RECIPIENT rather than
 * the integration — the only codes that map to `recipient_rejected` (see
 * `WhatsAppDeliveryFailureKind` for why that distinction is the whole point).
 *
 * Kept deliberately SHORT and explicit. Everything not listed here —
 * template errors, invalid parameters, expired tokens, account problems,
 * anything unrecognized — falls through to `provider_unavailable`, which is
 * the fail-loud direction: a code this list does not know about is a code
 * nobody has reasoned about, and the safe assumption is that logins are
 * broken for everyone rather than for one number.
 *
 *   131026 — Message undeliverable (recipient cannot receive WhatsApp
 *            messages: not a WhatsApp user, or unable to be reached).
 *   131052 — Media/URL download error for this message.
 *   130472 — This user's phone number is part of an experiment and messaging
 *            it is disallowed.
 */
export const RECIPIENT_SPECIFIC_ERROR_CODES = [131026, 131052, 130472] as const;

export interface WhatsAppCloudApiOptions {
  /** Graph API phone-number id of the sending WhatsApp Business number. */
  phoneNumberId: string;
  /** System-user or app access token. SECRET — never logged, never thrown. */
  accessToken: string;
  /** Name of the approved authentication template. */
  templateName: string;
  /** Template language code exactly as approved, e.g. `id` or `en_US`. */
  templateLanguage: string;
  /** Graph API version, e.g. `v21.0`. Defaults to the pinned constant. */
  graphVersion?: string;
  /** Whether the template carries an OTP button. See the class doc comment. */
  templateHasOtpButton?: boolean;
  /** Test seam — specs substitute a recording fake; production uses global fetch. */
  fetchFn?: typeof fetch;
}

export class WhatsAppCloudApiOtpProvider implements WhatsAppOtpProvider {
  private readonly logger = new Logger(WhatsAppCloudApiOtpProvider.name);
  private readonly endpoint: string;
  private readonly authorizationHeader: string;
  private readonly templateName: string;
  private readonly templateLanguage: string;
  private readonly templateHasOtpButton: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: WhatsAppCloudApiOptions) {
    // Fail at CONSTRUCTION, not at the first login attempt. `AuthModule`'s
    // factory and `env.validation.ts` both check these already; this is the
    // last of the three, and the only one that cannot be skipped by a code
    // path that built the provider directly. A client with a blank template
    // name would accept OTP requests and deliver nothing — exactly the
    // failure this whole work unit exists to make impossible.
    assertPresent(options.phoneNumberId, 'phoneNumberId');
    assertPresent(options.accessToken, 'accessToken');
    assertPresent(options.templateName, 'templateName');
    assertPresent(options.templateLanguage, 'templateLanguage');

    const trimmedVersion = options.graphVersion?.trim() ?? '';
    const graphVersion =
      trimmedVersion.length > 0
        ? trimmedVersion
        : DEFAULT_WHATSAPP_GRAPH_VERSION;

    // `encodeURIComponent` on both interpolated segments even though
    // `env.validation.ts` already constrains their shape: these values are
    // interpolated into a URL, and a path-traversal or query-injection
    // through a mis-set operator variable must not be able to redirect the
    // request to a different Graph edge.
    this.endpoint = `${WHATSAPP_GRAPH_BASE_URL}/${encodeURIComponent(
      graphVersion,
    )}/${encodeURIComponent(options.phoneNumberId.trim())}/messages`;
    this.authorizationHeader = `Bearer ${options.accessToken}`;
    this.templateName = options.templateName.trim();
    this.templateLanguage = options.templateLanguage.trim();
    this.templateHasOtpButton = options.templateHasOtpButton ?? true;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Sends one authentication-template message carrying `code`.
   *
   * Resolves ONLY on a 2xx whose body actually acknowledges the message with
   * a `messages[0].id`. A 2xx with an unrecognized body is treated as a
   * FAILURE, not a success: the whole point of this class is that "we
   * answered 202 and nothing arrived" cannot happen, and a body we cannot
   * read is indistinguishable from one that reported a problem.
   */
  async sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
    const response = await this.post(this.buildTemplateMessage(input));

    if (!response.ok) {
      throw await this.classifyFailure(response, input.phoneE164);
    }

    const body = await this.readJson(response);

    if (!acknowledgesMessage(body)) {
      // Reached only if Meta's success shape changes under us. Loud on
      // purpose — see this method's doc comment.
      this.logger.error(
        redactSensitiveText(
          `WhatsApp Cloud API returned HTTP ${response.status} with an unrecognized body ` +
            `for ...${lastFour(input.phoneE164)}; treating as undelivered`,
        ),
      );
      throw new WhatsAppDeliveryError(
        'provider_unavailable',
        'WhatsApp Cloud API accepted the request but did not acknowledge a message',
        response.status,
      );
    }
  }

  /**
   * The Cloud API send payload. `to` is the E.164 number WITHOUT its leading
   * `+`: Meta documents the recipient as a country-code-prefixed number and
   * writes every example in their reference that way.
   */
  private buildTemplateMessage(input: SendWhatsAppOtpInput): unknown {
    const codeParameter = { type: 'text', text: input.code };

    const components: unknown[] = [
      { type: 'body', parameters: [codeParameter] },
    ];

    if (this.templateHasOtpButton) {
      components.push({
        type: 'button',
        sub_type: 'url',
        // A STRING "0", matching Meta's own examples. The API tolerates an
        // integer, but there is no reason to differ from the documented form.
        index: '0',
        parameters: [codeParameter],
      });
    }

    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.phoneE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: this.templateName,
        language: { code: this.templateLanguage },
        components,
      },
    };
  }

  /**
   * The single transport choke point. `redirect: 'error'` and a bounded
   * timeout follow the `fetchSigned`/`HttpMidtransClient` house rules, and
   * the caught error is deliberately never inspected — it can embed the
   * request, whose `Authorization` header embeds the access token.
   *
   * A transport fault is `provider_unavailable` by construction: it happened
   * before any per-recipient logic could run, so it says nothing about the
   * number.
   */
  private async post(jsonBody: unknown): Promise<Response> {
    try {
      return await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: this.authorizationHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jsonBody),
        redirect: 'error',
        signal: AbortSignal.timeout(WHATSAPP_CLOUD_API_TIMEOUT_MS),
      });
    } catch {
      throw new WhatsAppDeliveryError(
        'provider_unavailable',
        'WhatsApp Cloud API request failed before a response was received (transport error or timeout)',
      );
    }
  }

  /**
   * Turns a non-2xx response into the right `WhatsAppDeliveryError`.
   *
   * HTTP STATUS DECIDES FIRST, because status is the stable,
   * version-independent part of the contract: 5xx is Meta being broken,
   * 401/403 is a token this deployment must fix, 429 is a send budget this
   * deployment has spent. None of those depend on the recipient.
   *
   * Only a plain 4xx is worth reading a body for, and even then only to pull
   * the documented `error.code` integer and compare it against the short
   * recipient-specific allowlist. Anything unrecognized —
   * template-does-not-exist, template-paused, parameter-mismatch,
   * account-restricted — is `provider_unavailable`, which is correct in
   * substance as well as in caution: every one of those breaks WhatsApp
   * login for EVERY user, and an operator needs to see 503 rather than a
   * quiet stream of 202s.
   */
  private async classifyFailure(
    response: Response,
    phoneE164: string,
  ): Promise<WhatsAppDeliveryError> {
    const status = response.status;

    if (status >= 500 || status === 401 || status === 403 || status === 429) {
      await this.discardBody(response);
      this.logDeliveryFailure(status, phoneE164, undefined);
      return new WhatsAppDeliveryError(
        'provider_unavailable',
        `WhatsApp Cloud API send failed with HTTP ${status}`,
        status,
      );
    }

    const errorCode = extractErrorCode(await this.readJson(response));
    this.logDeliveryFailure(status, phoneE164, errorCode);

    if (
      errorCode !== undefined &&
      (RECIPIENT_SPECIFIC_ERROR_CODES as readonly number[]).includes(errorCode)
    ) {
      return new WhatsAppDeliveryError(
        'recipient_rejected',
        `WhatsApp Cloud API refused this recipient (provider error ${errorCode})`,
        status,
      );
    }

    return new WhatsAppDeliveryError(
      'provider_unavailable',
      `WhatsApp Cloud API send failed with HTTP ${status}` +
        (errorCode !== undefined ? ` (provider error ${errorCode})` : ''),
      status,
    );
  }

  /**
   * The one log line for a failed send. Carries the status, the numeric
   * provider error code, and the last four digits of the destination —
   * enough for an operator to look the code up in Meta's error reference,
   * and nothing that identifies a person or a credential.
   */
  private logDeliveryFailure(
    status: number,
    phoneE164: string,
    errorCode: number | undefined,
  ): void {
    this.logger.error(
      redactSensitiveText(
        `WhatsApp Cloud API send to ...${lastFour(phoneE164)} responded HTTP ${status}` +
          (errorCode !== undefined ? ` (provider error ${errorCode})` : ''),
      ),
    );
  }

  /** A body that cannot be parsed is simply `undefined` — never thrown, never logged. */
  private async readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }

  /** Unread bodies are cancelled (`HttpMidtransClient` precedent). */
  private async discardBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to do — the body is being thrown away either way.
    }
  }
}

function assertPresent(value: string | undefined, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    // Names the FIELD, never the value — this message reaches a boot log.
    throw new Error(
      `Refusing to construct WhatsAppCloudApiOtpProvider: "${field}" is missing or empty. ` +
        'A Cloud API client without complete configuration would accept OTP requests and deliver nothing.',
    );
  }
}

/** Last four digits of an E.164 number — the only form permitted in a log. */
function lastFour(phoneE164: string): string {
  return phoneE164.slice(-4);
}

/**
 * Meta's documented success shape: `{ messages: [ { id: "wamid...." } ] }`.
 * Checked structurally rather than trusted, because "2xx" alone is not an
 * acknowledgement — see `sendOtp`.
 */
function acknowledgesMessage(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return false;
  }
  const first: unknown = body.messages[0];
  return isRecord(first) && typeof first.id === 'string' && first.id.length > 0;
}

/**
 * Meta's documented error shape: `{ error: { code: 131026, ... } }`. Only
 * the numeric code is read; the message, `error_data`, `fbtrace_id` and
 * everything else is deliberately ignored so no provider-authored string can
 * reach a log or a response.
 */
function extractErrorCode(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  const code: unknown = body.error.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
