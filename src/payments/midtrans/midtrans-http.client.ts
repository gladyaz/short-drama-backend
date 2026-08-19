import { Logger } from '@nestjs/common';
import { redactSensitiveText } from '../../common/logging/redact';
import {
  MidtransGateway,
  MidtransSnapCheckout,
  MidtransTransactionStatusResult,
} from './midtrans.types';

/**
 * Official Midtrans base URLs, verified against docs.midtrans.com
 * (2026-08-19). Snap transaction creation lives on the `app.*` hosts; the
 * Core API (GET transaction status) lives on the `api.*` hosts. Constants —
 * not env vars — because they are fixed, public provider facts; the ONLY
 * runtime switch is the sandbox/production flag, which
 * `env.validation.ts` refuses to set to production outside
 * `NODE_ENV=production`.
 */
export const MIDTRANS_SANDBOX_SNAP_BASE_URL =
  'https://app.sandbox.midtrans.com';
export const MIDTRANS_PRODUCTION_SNAP_BASE_URL = 'https://app.midtrans.com';
export const MIDTRANS_SANDBOX_API_BASE_URL = 'https://api.sandbox.midtrans.com';
export const MIDTRANS_PRODUCTION_API_BASE_URL = 'https://api.midtrans.com';

/**
 * Transport timeout per request. Well under the 15s Midtrans allows a
 * notification handler, and deliberately shorter than
 * `PAYMENT_CHECKOUT_STUCK_CREATED_MS` (5 min) so an in-flight checkout can
 * never be reclaimed as "abandoned" while its provider call could still
 * legitimately resolve.
 */
export const MIDTRANS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The one error type this client throws. Carries an optional HTTP status
 * and a FIXED, secret-free message — never the response body (could be
 * arbitrarily large/unexpected), never the request (its Authorization
 * header embeds the Server Key), and never the underlying transport error
 * (undici errors can embed the full request URL/headers — the
 * `fetchSigned` house rule).
 */
export class MidtransGatewayError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'MidtransGatewayError';
  }
}

export interface HttpMidtransClientOptions {
  serverKey: string;
  isProduction: boolean;
  /** Test seam — the spec substitutes a recording fake; production uses global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the real Midtrans
 * transport, and the ONLY file in this codebase that speaks Midtrans HTTP.
 * Constructed exclusively by `PaymentsModule`'s `MIDTRANS_GATEWAY` factory
 * when `PAYMENTS_ENABLED=true`; every test binds a fake to the token
 * instead, so no spec ever constructs a live-network instance.
 *
 * Authentication (verified contract): HTTP Basic with the Server Key as
 * username and an EMPTY password — `Basic base64(SERVER_KEY + ":")`. The
 * key is captured once into the prebuilt header string and never stored on
 * any other field, never logged (no log line in this file interpolates
 * request headers or the key, and every message passes through
 * `redactSensitiveText` anyway), and never present in a thrown error.
 */
export class HttpMidtransClient implements MidtransGateway {
  private readonly logger = new Logger(HttpMidtransClient.name);
  private readonly snapBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly authorizationHeader: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpMidtransClientOptions) {
    this.snapBaseUrl = options.isProduction
      ? MIDTRANS_PRODUCTION_SNAP_BASE_URL
      : MIDTRANS_SANDBOX_SNAP_BASE_URL;
    this.apiBaseUrl = options.isProduction
      ? MIDTRANS_PRODUCTION_API_BASE_URL
      : MIDTRANS_SANDBOX_API_BASE_URL;
    this.authorizationHeader = `Basic ${Buffer.from(
      `${options.serverKey}:`,
    ).toString('base64')}`;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * POST /snap/v1/transactions (verified contract): `order_id` (server
   * generated, String(50)-safe), `gross_amount` (whole IDR integer, no
   * decimals), an EXPLICIT expiry window, and 3DS left at its secure
   * default. Deliberately NO `customer_details` — data minimization: the
   * hosted page collects what it needs itself, and this backend sends the
   * provider no email/name/phone.
   */
  async createSnapTransaction(input: {
    orderId: string;
    grossAmountIdr: number;
    expiryMinutes: number;
  }): Promise<MidtransSnapCheckout> {
    const response = await this.request(
      'POST',
      `${this.snapBaseUrl}/snap/v1/transactions`,
      {
        transaction_details: {
          order_id: input.orderId,
          gross_amount: input.grossAmountIdr,
        },
        expiry: { unit: 'minutes', duration: input.expiryMinutes },
        credit_card: { secure: true },
      },
    );

    if (!response.ok) {
      await this.discardBody(response);
      this.logger.warn(
        redactSensitiveText(
          `Midtrans Snap create for order ${input.orderId} responded HTTP ${response.status}`,
        ),
      );
      throw new MidtransGatewayError(
        `Midtrans Snap create failed with HTTP ${response.status}`,
        response.status,
      );
    }

    const body = await this.readJson(response, 'Snap create');

    if (
      !isRecord(body) ||
      typeof body.token !== 'string' ||
      typeof body.redirect_url !== 'string'
    ) {
      throw new MidtransGatewayError(
        'Midtrans Snap create returned an unexpected response shape',
      );
    }

    return { token: body.token, redirectUrl: body.redirect_url };
  }

  /**
   * GET /v2/{order_id}/status (verified contract). "Transaction doesn't
   * exist" — either transport-level 404 or a 200 body carrying
   * `status_code: "404"` — resolves to `{ found: false }`: for a Snap order
   * the customer never started paying, that is the NORMAL answer, not an
   * error.
   */
  async getTransactionStatus(
    orderId: string,
  ): Promise<MidtransTransactionStatusResult> {
    const response = await this.request(
      'GET',
      `${this.apiBaseUrl}/v2/${encodeURIComponent(orderId)}/status`,
    );

    if (response.status === 404) {
      await this.discardBody(response);
      return { found: false };
    }

    if (!response.ok) {
      await this.discardBody(response);
      this.logger.warn(
        redactSensitiveText(
          `Midtrans status fetch for order ${orderId} responded HTTP ${response.status}`,
        ),
      );
      throw new MidtransGatewayError(
        `Midtrans status fetch failed with HTTP ${response.status}`,
        response.status,
      );
    }

    const body = await this.readJson(response, 'status fetch');

    if (!isRecord(body)) {
      throw new MidtransGatewayError(
        'Midtrans status fetch returned an unexpected response shape',
      );
    }

    if (body.status_code === '404') {
      return { found: false };
    }

    if (
      typeof body.transaction_status !== 'string' ||
      typeof body.order_id !== 'string'
    ) {
      throw new MidtransGatewayError(
        'Midtrans status fetch returned an unexpected response shape',
      );
    }

    return {
      found: true,
      orderId: body.order_id,
      transactionStatus: body.transaction_status,
      statusCode:
        typeof body.status_code === 'string' ? body.status_code : undefined,
      fraudStatus:
        typeof body.fraud_status === 'string' ? body.fraud_status : undefined,
      transactionId:
        typeof body.transaction_id === 'string'
          ? body.transaction_id
          : undefined,
      grossAmount:
        typeof body.gross_amount === 'string' ? body.gross_amount : undefined,
    };
  }

  /**
   * The single transport choke point. `redirect: 'error'` and a bounded
   * timeout follow the `fetchSigned` house rules; the caught transport
   * error is deliberately NEVER inspected, logged, or re-attached as
   * `cause` — undici errors can embed the full request, whose
   * Authorization header embeds the Server Key.
   */
  private async request(
    method: 'GET' | 'POST',
    url: string,
    jsonBody?: unknown,
  ): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: this.authorizationHeader,
          ...(jsonBody !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(MIDTRANS_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MidtransGatewayError(
        'Midtrans request failed before a response was received (transport error or timeout)',
      );
    }
  }

  private async readJson(response: Response, label: string): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new MidtransGatewayError(
        `Midtrans ${label} returned a non-JSON body`,
      );
    }
  }

  /** Non-2xx bodies are cancelled unread (`fetchSigned` precedent). */
  private async discardBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to do — the body is being thrown away either way.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
