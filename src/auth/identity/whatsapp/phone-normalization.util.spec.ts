import { AppErrorCode } from '../../../common/errors/app-error-code';
import { AppException } from '../../../common/errors/app.exception';
import {
  MAX_RAW_PHONE_INPUT_LENGTH,
  maskPhoneE164,
  normalizePhoneToE164,
} from './phone-normalization.util';

/**
 * PHASE 10B. `normalizePhoneToE164` produces the value stored as
 * `AuthIdentity.providerSubject` for the `whatsapp` provider, so its output
 * IS the identity key — two inputs that normalize differently are two
 * different accounts for one human, and two that normalize the same are one
 * account. That makes this a security test, not a formatting test, which is
 * why the "same human, different spellings" case below asserts equality of
 * the results rather than each result independently.
 */
describe('normalizePhoneToE164', () => {
  it('accepts an international number written with a leading plus', () => {
    expect(normalizePhoneToE164('+6281234567890')).toBe('+6281234567890');
  });

  it('rewrites an Indonesian national number beginning with 0 to +62', () => {
    expect(normalizePhoneToE164('081234567890')).toBe('+6281234567890');
  });

  it('treats a 00 international access prefix exactly like a plus', () => {
    expect(normalizePhoneToE164('006281234567890')).toBe('+6281234567890');
  });

  it('ignores spaces, hyphens, dots and parentheses wherever they appear', () => {
    expect(normalizePhoneToE164('+62 (812) 3456-7890')).toBe('+6281234567890');
    expect(normalizePhoneToE164('0812.3456.7890')).toBe('+6281234567890');
  });

  it('collapses every spelling one human might use for their own number onto ONE identity key', () => {
    // The whole reason this function exists: if these produced different
    // strings, the same person could end up with several accounts, and the
    // `AuthIdentity @@unique([provider, providerSubject])` constraint would
    // be enforcing nothing.
    const spellings = [
      '081234567890',
      '+6281234567890',
      '+62 812 3456 7890',
      '0812-3456-7890',
      '  +6281234567890  ',
      '006281234567890',
    ];

    const normalized = new Set(spellings.map(normalizePhoneToE164));

    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe('+6281234567890');
  });

  it('rejects a bare digit string with no plus, no 00 and no leading zero rather than guessing a country', () => {
    // `81234567890` could be Indonesian-without-the-zero, or a number in any
    // country whose calling code starts with 8. Guessing is exactly how two
    // humans end up sharing one identity.
    expectRejected('81234567890');
  });

  it('rejects any character that is neither a digit nor a recognized separator, instead of silently stripping it', () => {
    // Silent stripping is how two different inputs quietly collapse onto one
    // identity — e.g. "+62812a34567890" must not become "+6281234567890".
    expectRejected('+62812a34567890');
    expectRejected('+62812/34567890');
    expectRejected('+62812_34567890');
  });

  it('rejects a plus that is not the first character', () => {
    expectRejected('62+81234567890');
  });

  it('rejects a country calling code beginning with zero', () => {
    expectRejected('+0812345678');
  });

  it('rejects values that are too short or too long for E.164', () => {
    expectRejected('+621');
    expectRejected(`+${'6'.repeat(16)}`);
  });

  it('rejects empty and whitespace-only input', () => {
    expectRejected('');
    expectRejected('   ');
  });

  it('rejects oversized input before doing any per-character work', () => {
    expectRejected('+'.padEnd(MAX_RAW_PHONE_INPUT_LENGTH + 1, '6'));
  });

  it('never reveals WHICH rule failed — every rejection is the same generic shape error', () => {
    const rejections = [
      '81234567890',
      '+62812a34567890',
      '+0812345678',
      '',
    ].map(captureRejection);

    const distinctCodes = new Set(rejections.map((error) => error.code));
    const distinctMessages = new Set(rejections.map((error) => error.message));

    expect(distinctCodes).toEqual(new Set([AppErrorCode.INVALID_PHONE_NUMBER]));
    expect(distinctMessages.size).toBe(1);
  });
});

describe('maskPhoneE164', () => {
  it('reveals only the last four digits', () => {
    expect(maskPhoneE164('+6281234567890')).toBe('+*********7890');
  });

  it('never contains the leading digits of the original number', () => {
    const masked = maskPhoneE164('+6281234567890');

    expect(masked).not.toContain('62812');
    expect(masked.endsWith('7890')).toBe(true);
  });
});

function captureRejection(raw: string): AppException {
  try {
    normalizePhoneToE164(raw);
  } catch (error) {
    if (error instanceof AppException) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected "${raw}" to be rejected, but it was accepted.`);
}

function expectRejected(raw: string): void {
  const error = captureRejection(raw);
  expect(error.code).toBe(AppErrorCode.INVALID_PHONE_NUMBER);
}
