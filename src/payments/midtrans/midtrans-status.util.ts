import { PaymentOrderStatus } from '../payment-state.constants';
import { MidtransTransactionFields } from './midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the ONE place raw
 * Midtrans status fields become an internal `PaymentOrderStatus` target.
 * Pure (no DI, no I/O), fed identically by the webhook path and the GET
 * Status reconciliation path so the two can never disagree about what a
 * provider outcome means.
 *
 * Success semantics follow the verified official contract
 * (docs.midtrans.com "HTTP(S) Notification / Webhooks", 2026-08-19) —
 * "Transaction can be considered success if transaction_status value is
 * settlement (or capture in case of card transaction) and if fraud_status
 * exists ensure the value is accept", plus the documented three-field check
 * requiring `status_code` 200:
 *
 * - `settlement` / `capture` + (`fraud_status` absent or `"accept"`) +
 *   `status_code === "200"` → PAID. Anything weaker NEVER grants:
 * - `fraud_status: "challenge"` → PENDING (FDS manual review; a later
 *   notification resolves it — premium is NOT granted on a challenge).
 * - `fraud_status: "deny"` → FAILED.
 * - an UNRECOGNIZED `fraud_status` value → ignored (fail closed: an
 *   unknown fraud verdict must never be treated as acceptance).
 * - `settlement`/`capture` with a `status_code` other than `"200"`
 *   (or missing, on a reconciliation read) → ignored (fail closed).
 * - `pending` → PENDING; `authorize` → PENDING (funds only reserved —
 *   a later `capture`/`cancel` decides the outcome; never a grant).
 * - `deny` / `failure` → FAILED.
 * - `cancel` → CANCELED; `expire` → EXPIRED.
 * - `refund` / `partial_refund` → REFUNDED.
 * - any unknown `transaction_status` → ignored (logged by the caller,
 *   acknowledged to the provider, transitions nothing).
 */
export type MidtransStatusResolution =
  | { kind: 'transition'; target: PaymentOrderStatus }
  | { kind: 'ignored'; reason: string };

export function resolveMidtransTransactionStatus(
  fields: MidtransTransactionFields,
): MidtransStatusResolution {
  switch (fields.transactionStatus) {
    case 'settlement':
    case 'capture': {
      if (fields.fraudStatus !== undefined && fields.fraudStatus !== 'accept') {
        if (fields.fraudStatus === 'challenge') {
          return { kind: 'transition', target: 'PENDING' };
        }
        if (fields.fraudStatus === 'deny') {
          return { kind: 'transition', target: 'FAILED' };
        }
        return {
          kind: 'ignored',
          reason: 'unrecognized fraud_status on a success-shaped notification',
        };
      }
      if (fields.statusCode !== '200') {
        return {
          kind: 'ignored',
          reason:
            'success-shaped transaction_status without status_code 200 (official three-field success check failed)',
        };
      }
      return { kind: 'transition', target: 'PAID' };
    }
    case 'pending':
    case 'authorize':
      return { kind: 'transition', target: 'PENDING' };
    case 'deny':
    case 'failure':
      return { kind: 'transition', target: 'FAILED' };
    case 'cancel':
      return { kind: 'transition', target: 'CANCELED' };
    case 'expire':
      return { kind: 'transition', target: 'EXPIRED' };
    case 'refund':
    case 'partial_refund':
      return { kind: 'transition', target: 'REFUNDED' };
    default:
      return { kind: 'ignored', reason: 'unrecognized transaction_status' };
  }
}
