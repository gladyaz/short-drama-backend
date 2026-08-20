import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../../../common/errors/app-error-code';
import { AppException } from '../../../common/errors/app.exception';

/**
 * PHASE 10B — E.164 phone-number normalization.
 *
 * WHY NORMALIZATION IS A SECURITY CONTROL HERE, not formatting sugar:
 * `AuthIdentity.providerSubject` is the identity key for the `whatsapp`
 * provider, and its uniqueness is what guarantees one phone number maps to
 * at most one account. If "+62 812-3456-7890", "081234567890" and
 * "6281234567890" reached the database as three different strings, they
 * would become three different identities for ONE human — three parallel
 * accounts, three entitlement scopes, and a `@@unique` constraint enforcing
 * nothing. Every phone number is therefore reduced to exactly ONE canonical
 * form before it is hashed into an OTP, stored, or compared.
 *
 * WHY THIS IS HAND-ROLLED rather than `libphonenumber-js`: this repository
 * deliberately keeps a minimal dependency set and hand-rolls provider
 * clients it can fully test (see `midtrans-http.client.ts`, written against
 * the Midtrans HTTP contract rather than the vendor SDK). The rules below
 * are a STRICT SUBSET of E.164 — they normalize and validate structure, and
 * they never claim to know whether a number is assigned, reachable, or of a
 * particular line type. That is the right division of labour regardless of
 * library choice: the only real proof that a number belongs to the caller
 * is the OTP round trip, not any amount of offline parsing.
 *
 * THE ONE COUNTRY-SPECIFIC RULE, stated explicitly rather than hidden: a
 * national-format Indonesian number beginning `0` is rewritten to `+62`
 * (`DEFAULT_COUNTRY_CALLING_CODE`). This app's audience is Indonesian (see
 * the Indonesian-subtitle/`sourceLanguage` fields throughout the media
 * model), and "08..." is how essentially every Indonesian user writes their
 * own number. A leading `0` is not valid E.164 in any country, so this
 * rewrite can never shadow a legitimate international input; anything else
 * MUST arrive with an explicit `+<country code>` and is rejected otherwise,
 * rather than being guessed at.
 */

/** Indonesia (+62) — see this file's doc comment for why exactly one default exists. */
export const DEFAULT_COUNTRY_CALLING_CODE = '62';

/**
 * E.164 permits at most 15 digits INCLUDING the country calling code. The
 * minimum is not fixed by the standard; 8 is a conservative floor that
 * accepts the shortest real national numbers while rejecting obvious junk.
 */
export const MAX_E164_DIGITS = 15;
export const MIN_E164_DIGITS = 8;

/**
 * Bound on the raw string accepted before any processing, so an
 * unauthenticated caller cannot hand this function a multi-megabyte value
 * to strip character-by-character.
 */
export const MAX_RAW_PHONE_INPUT_LENGTH = 32;

function invalidPhoneNumber(): AppException {
  // Deliberately says nothing about WHICH rule failed, and nothing about
  // whether the number is known to this system — this is a shape error,
  // decided before any database read, and it must stay that way.
  return new AppException(
    AppErrorCode.INVALID_PHONE_NUMBER,
    'Phone number must be a valid international number in E.164 format (for example +6281234567890)',
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * Returns the canonical `+<digits>` E.164 form of `raw`, or throws
 * `INVALID_PHONE_NUMBER`.
 *
 * Accepted inputs: an international number with a leading `+` (or `00`
 * international prefix), or an Indonesian national number with a leading
 * `0`. Spaces, hyphens, dots and parentheses are ignored wherever they
 * appear. Any other character — including a `+` anywhere but the first
 * position — is a rejection, never something to silently strip: silently
 * dropping unexpected characters is how two different inputs quietly
 * collapse onto one identity.
 */
export function normalizePhoneToE164(raw: string): string {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_PHONE_INPUT_LENGTH) {
    throw invalidPhoneNumber();
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw invalidPhoneNumber();
  }

  const hasPlusPrefix = trimmed.startsWith('+');
  const body = hasPlusPrefix ? trimmed.slice(1) : trimmed;

  // Only true separators are ignorable. Everything else must be a digit.
  let digits = '';
  for (const character of body) {
    if (character >= '0' && character <= '9') {
      digits += character;
      continue;
    }
    if (
      character === ' ' ||
      character === '-' ||
      character === '.' ||
      character === '(' ||
      character === ')'
    ) {
      continue;
    }
    throw invalidPhoneNumber();
  }

  const nationalized = applyPrefixRules(digits, hasPlusPrefix);

  if (
    nationalized.length < MIN_E164_DIGITS ||
    nationalized.length > MAX_E164_DIGITS
  ) {
    throw invalidPhoneNumber();
  }

  // E.164 country calling codes never begin with 0.
  if (nationalized.startsWith('0')) {
    throw invalidPhoneNumber();
  }

  return `+${nationalized}`;
}

/**
 * Resolves the three accepted prefix conventions to a bare, country-coded
 * digit string. Kept separate from the character-level scan above so each
 * half stays small and independently testable (`common/coding-style.md`:
 * small, focused functions).
 */
function applyPrefixRules(digits: string, hasPlusPrefix: boolean): string {
  if (hasPlusPrefix) {
    // Already international: `+62812...`. A `+0...` is invalid and is
    // caught by the leading-zero check in the caller.
    return digits;
  }

  // `0062812...` — the ITU international access prefix written out. Treated
  // exactly like a `+`.
  if (digits.startsWith('00')) {
    return digits.slice(2);
  }

  // `0812...` — Indonesian national format. See this file's doc comment for
  // why this single country default exists and why it cannot shadow a
  // legitimate international input.
  if (digits.startsWith('0')) {
    return `${DEFAULT_COUNTRY_CALLING_CODE}${digits.slice(1)}`;
  }

  // A bare digit string with no `+`, no `00` and no leading `0` is
  // ambiguous: `81234567890` could be Indonesian-without-the-zero or a
  // number in any country whose code starts with 8. Guessing here is
  // exactly how two humans end up sharing one identity, so it is refused —
  // the caller must be explicit.
  throw invalidPhoneNumber();
}

/**
 * Last four digits, with the rest masked — the ONLY form of a phone number
 * that may appear in an API response for an identity listing or in any
 * operator-facing surface. A linked-identity list is shown to a caller who
 * has already authenticated, but it is also the kind of response that ends
 * up in client logs, crash reports and support screenshots, so it carries a
 * masked value rather than the full number the account was created with.
 */
export function maskPhoneE164(phoneE164: string): string {
  const visible = phoneE164.slice(-4);
  return `+${'*'.repeat(Math.max(phoneE164.length - 5, 0))}${visible}`;
}
