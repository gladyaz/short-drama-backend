import {
  computeMidtransSignatureKey,
  isValidMidtransSignatureKey,
} from './midtrans-signature.util';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": webhook authenticity
 * math. `KNOWN_VECTOR` was computed INDEPENDENTLY (node -e, sha512 of the
 * literal concatenation) rather than by calling the unit under test, so a
 * formula regression — wrong field order, a separator sneaking in, a
 * different hash — fails against a fixed constant instead of being
 * self-consistent.
 */
const VECTOR_INPUT = {
  orderId: 'sd-test-order-1',
  statusCode: '200',
  grossAmount: '49000.00',
  serverKey: 'test-server-key-fixture',
};

const KNOWN_VECTOR =
  '57d770fb5308e6370ba0a739dc7bff456a028ff4b705b022e528ca7f9bbfd70790ad177281c3da28acc485e65a1cbe59a6fc8414d6fed16a7f0fd3932365c0bc';

describe('computeMidtransSignatureKey', () => {
  it('CRITICAL: implements SHA512(order_id + status_code + gross_amount + ServerKey) exactly', () => {
    expect(computeMidtransSignatureKey(VECTOR_INPUT)).toBe(KNOWN_VECTOR);
  });

  it('is sensitive to every input field', () => {
    expect(
      computeMidtransSignatureKey({ ...VECTOR_INPUT, orderId: 'sd-other' }),
    ).not.toBe(KNOWN_VECTOR);
    expect(
      computeMidtransSignatureKey({ ...VECTOR_INPUT, statusCode: '201' }),
    ).not.toBe(KNOWN_VECTOR);
    expect(
      computeMidtransSignatureKey({ ...VECTOR_INPUT, grossAmount: '1.00' }),
    ).not.toBe(KNOWN_VECTOR);
    expect(
      computeMidtransSignatureKey({ ...VECTOR_INPUT, serverKey: 'wrong' }),
    ).not.toBe(KNOWN_VECTOR);
  });
});

describe('isValidMidtransSignatureKey', () => {
  it('accepts the authentic signature', () => {
    expect(
      isValidMidtransSignatureKey({
        ...VECTOR_INPUT,
        signatureKey: KNOWN_VECTOR,
      }),
    ).toBe(true);
  });

  it('accepts an uppercase presentation of the correct digest', () => {
    expect(
      isValidMidtransSignatureKey({
        ...VECTOR_INPUT,
        signatureKey: KNOWN_VECTOR.toUpperCase(),
      }),
    ).toBe(true);
  });

  it('CRITICAL: rejects a signature computed with a different Server Key (forged webhook)', () => {
    const forged = computeMidtransSignatureKey({
      ...VECTOR_INPUT,
      serverKey: 'attacker-guessed-key',
    });
    expect(
      isValidMidtransSignatureKey({ ...VECTOR_INPUT, signatureKey: forged }),
    ).toBe(false);
  });

  it('CRITICAL: rejects when the payload fields were tampered after signing', () => {
    expect(
      isValidMidtransSignatureKey({
        ...VECTOR_INPUT,
        grossAmount: '1.00',
        signatureKey: KNOWN_VECTOR,
      }),
    ).toBe(false);
    expect(
      isValidMidtransSignatureKey({
        ...VECTOR_INPUT,
        statusCode: '201',
        signatureKey: KNOWN_VECTOR,
      }),
    ).toBe(false);
    expect(
      isValidMidtransSignatureKey({
        ...VECTOR_INPUT,
        orderId: 'sd-someone-elses-order',
        signatureKey: KNOWN_VECTOR,
      }),
    ).toBe(false);
  });

  it('rejects a wrong-length signature without throwing (timingSafeEqual length guard)', () => {
    expect(
      isValidMidtransSignatureKey({
        ...VECTOR_INPUT,
        signatureKey: 'deadbeef',
      }),
    ).toBe(false);
    expect(
      isValidMidtransSignatureKey({ ...VECTOR_INPUT, signatureKey: '' }),
    ).toBe(false);
  });

  it('rejects a same-length but different digest', () => {
    const flipped = `${KNOWN_VECTOR.slice(0, -1)}${
      KNOWN_VECTOR.endsWith('c') ? 'd' : 'c'
    }`;
    expect(
      isValidMidtransSignatureKey({ ...VECTOR_INPUT, signatureKey: flipped }),
    ).toBe(false);
  });
});
