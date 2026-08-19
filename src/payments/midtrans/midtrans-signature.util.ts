import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": webhook authenticity per
 * the CURRENT official Midtrans contract (docs.midtrans.com, "HTTP(S)
 * Notification / Webhooks", verified 2026-08-19):
 *
 *   signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
 *
 * Plain string concatenation in exactly that order, hex digest. The three
 * payload fields are used EXACTLY as delivered (in particular
 * `gross_amount` is the provider's decimal STRING, e.g. `"49000.00"` — it
 * must not be re-formatted before hashing, or every real signature would
 * fail). The Server Key is the secret; a caller who does not hold it cannot
 * produce a valid `signature_key` for any (order, status, amount) triple.
 *
 * Pure functions (no Nest DI, no I/O) so the spec can exercise them
 * exhaustively without any provider or network involvement.
 */
export function computeMidtransSignatureKey(input: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  serverKey: string;
}): string {
  return createHash('sha512')
    .update(
      `${input.orderId}${input.statusCode}${input.grossAmount}${input.serverKey}`,
    )
    .digest('hex');
}

/**
 * Timing-safe comparison of the presented `signature_key` against the
 * expected one. Hex case is normalized first (Midtrans emits lowercase hex;
 * an uppercase presentation of the correct digest is still authentic).
 * A length mismatch returns `false` immediately — `timingSafeEqual` demands
 * equal-length buffers, and the expected digest's LENGTH (128 hex chars) is
 * public knowledge, not a secret an early return could leak.
 */
export function isValidMidtransSignatureKey(input: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  serverKey: string;
  signatureKey: string;
}): boolean {
  const expected = computeMidtransSignatureKey(input);
  const presented = input.signatureKey.toLowerCase();

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const presentedBuffer = Buffer.from(presented, 'utf8');

  if (expectedBuffer.length !== presentedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, presentedBuffer);
}
