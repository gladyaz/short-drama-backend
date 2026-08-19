/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the internal payment
 * order state machine. `PaymentOrder.status` is a plain `String` column
 * (matching the `Video.lifecycleState`/`processingState` precedent), and
 * THIS file is its single app-layer source of truth: the closed value set,
 * and the closed transition relation every write must satisfy.
 *
 * Raw Midtrans `transaction_status` strings are NEVER stored as the domain
 * state — they are normalized through
 * `midtrans/midtrans-status.util.ts::resolveMidtransTransactionStatus` into
 * one of these internal states first (the last-seen raw provider string is
 * kept separately in `PaymentOrder.providerTransactionStatus`, purely as
 * audit metadata).
 *
 * Every transition is applied as a guarded `updateMany` CAS whose `where`
 * clause is `status: { in: paymentOrderStatusesAllowingTransitionTo(target) }`
 * — the `TranscodeIntentService.transitionIfVersion` idiom — so an illegal,
 * duplicate, or out-of-order transition matches 0 rows and writes NOTHING.
 * That makes monotonicity a database guarantee, not a check-then-act hope:
 * a delayed `pending` webhook arriving after `settlement` finds no row in a
 * PENDING-admitting state and is a no-op.
 *
 * Shape of the relation ("money received always wins; paid never
 * downgrades"):
 *
 *   CREATED  -> PENDING | PAID | FAILED | EXPIRED | CANCELED
 *   PENDING  -> PAID | FAILED | EXPIRED | CANCELED
 *   FAILED   -> PENDING | PAID | EXPIRED
 *   EXPIRED  -> PAID
 *   CANCELED -> PAID
 *   PAID     -> REFUNDED
 *   REFUNDED -> (terminal)
 *
 * Why FAILED/EXPIRED/CANCELED are re-enterable INTO `PAID` (and FAILED into
 * PENDING) rather than strictly terminal: (a) the hosted Snap page lets a
 * customer RETRY a denied attempt under the SAME `order_id`, so
 * `deny -> pending -> settlement` is a real, documented provider sequence —
 * a strictly-terminal FAILED would refuse to record money that was actually
 * taken; (b) `EXPIRED` can be set by our own lazy local-expiry inference
 * (`PaymentsService`), and a signature-verified `settlement` is
 * provider-authoritative over that inference. The monotonicity requirement
 * that actually protects users — nothing ever moves OUT of `PAID` except a
 * real refund, and no regressive webhook can downgrade any state — is fully
 * preserved: `PAID` and `REFUNDED` admit no backward edge.
 */
export type PaymentOrderStatus =
  | 'CREATED'
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'REFUNDED';

export const PAYMENT_ORDER_STATUSES: readonly PaymentOrderStatus[] = [
  'CREATED',
  'PENDING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELED',
  'REFUNDED',
];

/**
 * States in which an order still holds its `openOrderKey` (the per-user,
 * per-plan checkout idempotency slot). Every CAS that leaves this set MUST
 * clear `openOrderKey` in the same write.
 */
export const OPEN_PAYMENT_ORDER_STATUSES: readonly PaymentOrderStatus[] = [
  'CREATED',
  'PENDING',
];

const ALLOWED_TRANSITIONS: Record<
  PaymentOrderStatus,
  readonly PaymentOrderStatus[]
> = {
  CREATED: ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELED'],
  PENDING: ['PAID', 'FAILED', 'EXPIRED', 'CANCELED'],
  FAILED: ['PENDING', 'PAID', 'EXPIRED'],
  EXPIRED: ['PAID'],
  CANCELED: ['PAID'],
  PAID: ['REFUNDED'],
  REFUNDED: [],
};

export function isPaymentOrderStatus(
  value: string,
): value is PaymentOrderStatus {
  return (PAYMENT_ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransitionPaymentOrder(
  from: PaymentOrderStatus,
  to: PaymentOrderStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The exact set a transition-to-`target` CAS may match in its `where`
 * clause — derived from the relation rather than hand-listed at each call
 * site, so the map above stays the single source of truth.
 */
export function paymentOrderStatusesAllowingTransitionTo(
  target: PaymentOrderStatus,
): readonly PaymentOrderStatus[] {
  return PAYMENT_ORDER_STATUSES.filter((from) =>
    canTransitionPaymentOrder(from, target),
  );
}

/**
 * Closed set of INTERNAL `PaymentOrder.failureCode` values (never a raw
 * provider string; the raw provider status lives in
 * `providerTransactionStatus`):
 * - `PROVIDER_CREATE_FAILED`: the Midtrans Snap create call failed during
 *   checkout — order CAS-failed so the user can retry cleanly.
 * - `CHECKOUT_ABANDONED`: a `CREATED` order sat unresolved past
 *   `PAYMENT_CHECKOUT_STUCK_CREATED_MS` (crashed checkout) and was
 *   reclaimed by a later checkout attempt.
 * - `CHECKOUT_WINDOW_ELAPSED`: an open order's `checkoutExpiresAt` passed
 *   without a provider `expire` notification having arrived; expired
 *   locally so the plan slot frees up.
 */
export type PaymentFailureCode =
  'PROVIDER_CREATE_FAILED' | 'CHECKOUT_ABANDONED' | 'CHECKOUT_WINDOW_ELAPSED';
