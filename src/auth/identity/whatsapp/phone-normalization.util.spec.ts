import { AppErrorCode } from '../../../common/errors/app-error-code';
import { AppException } from '../../../common/errors/app.exception';
import {
  MAX_E164_DIGITS,
  MAX_RAW_PHONE_INPUT_LENGTH,
  MIN_E164_DIGITS,
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

/**
 * WHATSAPP LOGIN V1 — boundary and malformed-input coverage, added because
 * this function is the thing that decides whether two spellings of one
 * person's number become one identity or two. Every case below is either an
 * exact boundary of a documented rule or an input a real Indonesian user
 * plausibly types.
 */
describe('normalizePhoneToE164 — boundaries and malformed input', () => {
  describe('E.164 length boundaries are exact, not approximate', () => {
    it('accepts exactly MIN_E164_DIGITS', () => {
      const raw = `+${'6'.repeat(MIN_E164_DIGITS)}`;
      expect(normalizePhoneToE164(raw)).toBe(raw);
    });

    it('rejects one digit below MIN_E164_DIGITS', () => {
      expect(() =>
        normalizePhoneToE164(`+${'6'.repeat(MIN_E164_DIGITS - 1)}`),
      ).toThrow(AppException);
    });

    it('accepts exactly MAX_E164_DIGITS', () => {
      const raw = `+${'6'.repeat(MAX_E164_DIGITS)}`;
      expect(normalizePhoneToE164(raw)).toBe(raw);
    });

    it('rejects one digit above MAX_E164_DIGITS', () => {
      expect(() =>
        normalizePhoneToE164(`+${'6'.repeat(MAX_E164_DIGITS + 1)}`),
      ).toThrow(AppException);
    });

    it('measures length AFTER the 0 -> 62 rewrite, not before', () => {
      // 14 national digits become 15 with the country code — the ceiling.
      expect(normalizePhoneToE164(`0${'8'.repeat(13)}`)).toBe(
        `+62${'8'.repeat(13)}`,
      );
      // 15 national digits would become 16, which must be refused.
      expect(() => normalizePhoneToE164(`0${'8'.repeat(14)}`)).toThrow(
        AppException,
      );
    });

    it('accepts input at exactly MAX_RAW_PHONE_INPUT_LENGTH', () => {
      // Padded to the cap with ignorable separators.
      const raw = '+6281234567890'.padEnd(MAX_RAW_PHONE_INPUT_LENGTH, '-');
      expect(raw).toHaveLength(MAX_RAW_PHONE_INPUT_LENGTH);
      expect(normalizePhoneToE164(raw)).toBe('+6281234567890');
    });

    it('rejects input one character over the raw cap', () => {
      expect(() =>
        normalizePhoneToE164('0'.repeat(MAX_RAW_PHONE_INPUT_LENGTH + 1)),
      ).toThrow(AppException);
    });
  });

  describe('real Indonesian spellings all reach one identity key', () => {
    it.each([
      '081234567890',
      '  081234567890  ',
      '0812-3456-7890',
      '0812 3456 7890',
      '(0812) 3456-7890',
      '+6281234567890',
      '+62 812 3456 7890',
      '+62-812-3456-7890',
      '006281234567890',
    ])('%s normalizes to +6281234567890', (raw) => {
      expect(normalizePhoneToE164(raw)).toBe('+6281234567890');
    });
  });

  describe('international numbers are not assumed Indonesian', () => {
    it.each([
      ['+14155552671', '+14155552671'],
      ['+442071838750', '+442071838750'],
      ['+6591234567', '+6591234567'],
      ['+60123456789', '+60123456789'],
      ['0014155552671', '+14155552671'],
    ])('%s normalizes to %s untouched by the +62 default', (raw, expected) => {
      expect(normalizePhoneToE164(raw)).toBe(expected);
    });

    it('CRITICAL: the 0 -> 62 rewrite can never shadow an international number', () => {
      // A leading 0 is invalid E.164 in EVERY country, so no legitimate
      // international input can reach the Indonesian branch.
      expect(() => normalizePhoneToE164('+0014155552671')).toThrow(
        AppException,
      );
    });
  });

  describe('malformed input is refused, never repaired', () => {
    it.each([
      ['a lone plus', '+'],
      ['a lone zero', '0'],
      ['only separators', '---   ---'],
      ['a doubled plus', '++6281234567890'],
      ['a trailing plus', '6281234567890+'],
      ['an embedded plus', '+62812+34567890'],
      ['letters', '+62812ABC4567890'],
      ['an extension marker', '+6281234567890x123'],
      ['a unicode full-width digit', '+６２81234567890'],
      ['an arabic-indic digit', '+٦٢81234567890'],
      ['an interior newline', '+62812\n34567890'],
      ['a null byte', '+6281234567890\u0000'],
      ['a tab inside', '+62812\t34567890'],
      ['an underscore', '+62812_34567890'],
      ['a slash', '+62812/34567890'],
      ['a comma', '+62,812,3456,7890'],
    ])('rejects %s', (_label, raw) => {
      expect(() => normalizePhoneToE164(raw)).toThrow(AppException);
    });

    it('trims surrounding whitespace, including a trailing newline, before parsing', () => {
      // Deliberate: the explicit `.trim()` runs first, so a value pasted out
      // of a text field with a stray newline is accepted rather than
      // rejected for a reason a user cannot see. An INTERIOR newline is
      // still refused (above) — trimming the ends is not the same as
      // stripping characters from the middle.
      expect(normalizePhoneToE164('  +6281234567890\n')).toBe('+6281234567890');
    });

    it('CRITICAL: separators are ignored but no OTHER character is stripped', () => {
      // If a stray character were silently dropped, these two DIFFERENT
      // inputs would collapse onto one identity — one human's account
      // reachable by another's typo.
      expect(normalizePhoneToE164('+62812-3456-7890')).toBe('+6281234567890');
      expect(() => normalizePhoneToE164('+62812:3456:7890')).toThrow(
        AppException,
      );
    });
  });

  describe('non-string input cannot crash the normalizer', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 6281234567890],
      ['an object', { phone: '+6281234567890' }],
      ['an array', ['+6281234567890']],
    ])('rejects %s with the same generic shape error', (_label, raw) => {
      expect(() => normalizePhoneToE164(raw as unknown as string)).toThrow(
        AppException,
      );
    });
  });
});
