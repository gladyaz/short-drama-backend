import { createHmac } from 'crypto';

/**
 * Phase 12, work unit 12B-B2: shared, testable home for the two small
 * cryptographic/sanitization primitives `AuthAuditService` (Phase 12,
 * work unit 12A-B3) already implemented for `AuthAuditEvent.ipHash`/
 * `AuthAuditEvent.userAgent`, and that `AuthService`'s session-writing path
 * (`issueTokensAndSession`/`refresh`) now ALSO needs for the new
 * `Session.ipHash`/`Session.userAgent` columns (DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 6). Extracted here so both call sites share
 * ONE implementation — a divergence between how audit rows and session rows
 * hash the same IP (or sanitize the same user-agent string) would itself be
 * a real defect, not just duplicated code.
 */

/**
 * Hard cap applied to `userAgent` before persistence, in EITHER
 * `AuthAuditEvent.userAgent` or `Session.userAgent` (DECISIONS.md decision 6:
 * "truncated and sanitized"). 255 comfortably fits every real browser/app
 * user-agent string while bounding an attacker-controlled header.
 */
export const MAX_USER_AGENT_LENGTH = 255;

/**
 * HMAC-SHA256 of the raw IP, keyed with the supplied secret — never plain/
 * unkeyed SHA-256, so a leak of the table alone (e.g. a DB dump) cannot be
 * used to test candidate IPs against stored hashes without also knowing the
 * secret, and rotating the secret invalidates the ability to correlate old
 * hashes with new ones if ever needed as an incident-response measure
 * (mirrors `AuthService.hashRefreshToken`'s existing rationale for the same
 * HMAC-vs-plain-hash choice). Both call sites (`AuthAuditService.emit` for
 * `AuthAuditEvent.ipHash`, and `AuthService` for the new `Session.ipHash`)
 * pass the SAME `authConfig.authAuditIpHashSecret` — see that field's doc
 * comment in `config/configuration.ts` for why reusing it (rather than
 * minting a second env var) still satisfies decision 6's "dedicated secret,
 * distinct from the JWT/refresh-token signing secrets" requirement.
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

/**
 * Strips ASCII control characters (code points 0x00-0x1F and 0x7F) and
 * truncates to `MAX_USER_AGENT_LENGTH`. Filters by character code rather
 * than a `/[\x00-\x1F\x7F]/` regex literal (the more common approach) to
 * avoid the ESLint `no-control-regex` rule this project runs clean under —
 * behaviorally identical, just expressed without a raw control-character
 * regex.
 */
export function sanitizeUserAgent(userAgent: string): string {
  const withoutControlCharacters = Array.from(userAgent)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('');

  return withoutControlCharacters.slice(0, MAX_USER_AGENT_LENGTH);
}
