import type { PaymentOrder } from '@prisma/client';
import {
  isPaymentOrderStatus,
  PaymentOrderStatus,
} from './payment-state.constants';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": client-facing response
 * shapes for the payments API. Deliberately NARROW — no raw provider
 * payload, no `signature_key`, no Snap token (the hosted `checkoutUrl`
 * already embeds everything the client needs), and obviously never any
 * Server Key material. `providerOrderId` IS exposed: it is a server-minted
 * opaque id (`sd-<uuid>`) that Midtrans echoes into the redirect-return
 * query string as `order_id`, so a returning frontend can ask
 * `GET /payments/:orderId` about it — the backend answer, never the
 * redirect itself, is the payment authority.
 */
export interface CheckoutResponseDto {
  /** Internal `PaymentOrder.id` — the canonical reference for `GET /payments/:orderId`. */
  orderId: string;
  /** Server-minted Midtrans `order_id` (also accepted by `GET /payments/:orderId`). */
  providerOrderId: string;
  planId: string;
  status: PaymentOrderStatus;
  amountIdr: number;
  currency: string;
  /** Hosted Midtrans payment page to redirect the customer to. */
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
}

export interface PaymentOrderStatusDto {
  orderId: string;
  providerOrderId: string;
  planId: string;
  status: PaymentOrderStatus;
  amountIdr: number;
  currency: string;
  /** Convenience flag — true iff `status === 'PAID'`. */
  isPaid: boolean;
  paidAt: string | null;
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  createdAt: string;
}

/** Minimal acknowledgment body the Midtrans webhook answers with. */
export interface PaymentWebhookAckDto {
  status: 'ok';
}

/**
 * `PaymentOrder.status` is a plain DB string; narrowing it here (instead of
 * a blind cast) means a corrupted/unknown value fails LOUDLY as a 500 at
 * read time rather than silently masquerading as a real state — the same
 * fail-loud posture `toVideoContentKind` documents, except payment state is
 * too load-bearing for a "default to something plausible" fallback.
 */
function asPaymentOrderStatus(value: string): PaymentOrderStatus {
  if (!isPaymentOrderStatus(value)) {
    throw new Error(
      `PaymentOrder.status holds an unknown value — refusing to serve it as a payment state`,
    );
  }
  return value;
}

export function toCheckoutResponseDto(
  order: PaymentOrder,
): CheckoutResponseDto {
  return {
    orderId: order.id,
    providerOrderId: order.providerOrderId,
    planId: order.planId,
    status: asPaymentOrderStatus(order.status),
    amountIdr: order.amountIdr,
    currency: order.currency,
    checkoutUrl: order.checkoutUrl,
    checkoutExpiresAt: order.checkoutExpiresAt?.toISOString() ?? null,
  };
}

export function toPaymentOrderStatusDto(
  order: PaymentOrder,
): PaymentOrderStatusDto {
  return {
    orderId: order.id,
    providerOrderId: order.providerOrderId,
    planId: order.planId,
    status: asPaymentOrderStatus(order.status),
    amountIdr: order.amountIdr,
    currency: order.currency,
    isPaid: order.status === ('PAID' satisfies PaymentOrderStatus),
    paidAt: order.paidAt?.toISOString() ?? null,
    checkoutUrl: order.checkoutUrl,
    checkoutExpiresAt: order.checkoutExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}
