/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the provider PORT — the
 * one boundary behind which every Midtrans HTTP detail lives, mirroring the
 * `TranscodeQueue`/`TRANSCODE_QUEUE` interface + DI-token convention
 * exactly. Business services (`PaymentsService`,
 * `PaymentNotificationService`) depend only on this interface; tests and
 * the e2e suite substitute it with `.overrideProvider(MIDTRANS_GATEWAY)`,
 * so NO real Midtrans request is ever made by the normal test suites.
 *
 * Two implementations exist:
 * - `HttpMidtransClient` (`midtrans-http.client.ts`): the real transport,
 *   constructed by `PaymentsModule`'s factory ONLY when
 *   `PAYMENTS_ENABLED=true`.
 * - `DisabledMidtransGateway` (`midtrans-disabled.client.ts`): the inert
 *   default that rejects every call with `PAYMENTS_DISABLED` — a
 *   defense-in-depth backstop behind the services' own flag checks.
 */
export interface MidtransSnapCheckout {
  /** The Snap token (client-facing by design; still never logged). */
  token: string;
  /** The hosted payment page URL the customer is redirected to. */
  redirectUrl: string;
}

/**
 * Normalized subset of a Midtrans transaction's status fields, shared by
 * the webhook notification path and the GET Status reconciliation path so
 * both feed the SAME resolution logic
 * (`midtrans-status.util.ts::resolveMidtransTransactionStatus`).
 */
export interface MidtransTransactionFields {
  transactionStatus: string;
  statusCode?: string;
  fraudStatus?: string;
  transactionId?: string;
  grossAmount?: string;
}

export type MidtransTransactionStatusResult =
  | ({ found: true; orderId: string } & MidtransTransactionFields)
  | { found: false };

export interface MidtransGateway {
  /**
   * POST /snap/v1/transactions — creates the hosted checkout. `orderId` and
   * `grossAmountIdr` are SERVER-generated/-computed values
   * (`PaymentOrder.providerOrderId` / `.amountIdr`); nothing here ever came
   * from a client.
   */
  createSnapTransaction(input: {
    orderId: string;
    grossAmountIdr: number;
    expiryMinutes: number;
  }): Promise<MidtransSnapCheckout>;

  /**
   * GET /v2/{orderId}/status — the authoritative reconciliation read. A
   * transaction Midtrans does not know (customer never opened the payment
   * page, or plain 404) resolves to `{ found: false }`, never a throw.
   */
  getTransactionStatus(
    orderId: string,
  ): Promise<MidtransTransactionStatusResult>;
}

/** DI token, following the `TRANSCODE_QUEUE` string-token convention. */
export const MIDTRANS_GATEWAY = 'PAYMENTS_MIDTRANS_GATEWAY';
