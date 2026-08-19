/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the server-side premium
 * package catalog — the ONLY source of payment pricing and entitlement
 * duration in this codebase. A client selects a `PaymentPlan.id`; the
 * backend resolves everything else. No client-supplied amount is ever
 * read anywhere in the payments module.
 *
 * A code-defined constant catalog (not a DB table) is the smallest coherent
 * shape for this slice: no Plan/Product model existed before it (Phase 0
 * audit), the catalog is tiny and read-only, and prices changing requires a
 * deliberate reviewed code change rather than a mutable admin surface that
 * does not exist yet. Promoting this to a DB-backed catalog is an explicit
 * follow-up once product owns pricing.
 *
 * PRICES ARE PLACEHOLDERS pending a product-owner decision — they are
 * deliberately sane, whole-rupiah values (Midtrans: IDR only, no decimals)
 * so the flow is exercised realistically, but nothing in this slice treats
 * them as an approved price list. There is deliberately NO fee/markup
 * column and no fee arithmetic anywhere: no approved product contract
 * requires one (the work-unit brief explicitly forbids inventing a 2% fee),
 * and `PaymentOrder.amountIdr` — the charged gross — is simply the plan
 * price. Adding a fee later is an additive catalog + order-column change.
 *
 * No recurring billing: Phase 0 confirmed nothing in the product models a
 * subscription, so each plan is a ONE-TIME purchase of `durationDays` of
 * account-wide premium (`EntitlementsService.grantPaidPremium` stacks
 * consecutive purchases).
 */
export interface PaymentPlan {
  /** Stable public identifier a client sends to `POST /payments/checkout`. */
  id: string;
  /** Human-readable label (Indonesian, matching the target market). */
  name: string;
  /** Days of account-wide premium one purchase of this plan grants. */
  durationDays: number;
  /** Authoritative one-time price in whole IDR (no decimals — Midtrans contract). */
  priceIdr: number;
}

export const PAYMENT_PLANS: readonly PaymentPlan[] = [
  {
    id: 'premium-7d',
    name: 'Premium 7 Hari',
    durationDays: 7,
    priceIdr: 19000,
  },
  {
    id: 'premium-30d',
    name: 'Premium 30 Hari',
    durationDays: 30,
    priceIdr: 49000,
  },
  {
    id: 'premium-90d',
    name: 'Premium 90 Hari',
    durationDays: 90,
    priceIdr: 129000,
  },
];

export function findPaymentPlan(planId: string): PaymentPlan | undefined {
  return PAYMENT_PLANS.find((plan) => plan.id === planId);
}

/** `PaymentOrder.provider` value — the only provider this slice integrates. */
export const PAYMENT_PROVIDER_MIDTRANS = 'midtrans';

/**
 * `Entitlement.source` value written for payment-granted premium — the
 * schema's `Entitlement.source` doc comment anticipated exactly this: a
 * plain-string source added WITHOUT a migration alongside `'dev-grant'`.
 */
export const PAYMENT_ENTITLEMENT_SOURCE_MIDTRANS = 'midtrans';

/** `PaymentOrder.currency` — Midtrans Snap supports IDR only (verified contract). */
export const PAYMENT_CURRENCY_IDR = 'IDR';

/**
 * Hosted Snap checkout page lifetime, passed EXPLICITLY to Midtrans as
 * `expiry: { unit: "minutes", duration: ... }` at transaction creation and
 * mirrored into `PaymentOrder.checkoutExpiresAt`. Keeping our copy lets
 * `PaymentsService` lazily self-expire an open order whose payment window
 * has already closed WITHOUT depending on the provider's `expire` webhook
 * having arrived (local dev has no webhook delivery at all), so a user is
 * never permanently blocked from re-purchasing a plan by a dead open order.
 * 24 hours matches Midtrans' own default Snap expiry.
 */
export const PAYMENT_CHECKOUT_EXPIRY_MINUTES = 24 * 60;

/**
 * How long a `CREATED` order (row inserted, Snap create call never
 * resolved — e.g. the process crashed mid-checkout) may block its
 * user+plan `openOrderKey` slot before a new checkout reclaims it by
 * CAS-failing it (`failureCode: CHECKOUT_ABANDONED`). Long enough that a
 * healthy in-flight provider call (10s transport timeout) can never be
 * reclaimed from under a concurrent request; short enough that a crashed
 * checkout self-heals on the user's next attempt instead of demanding
 * operator intervention.
 */
export const PAYMENT_CHECKOUT_STUCK_CREATED_MS = 5 * 60 * 1000;
