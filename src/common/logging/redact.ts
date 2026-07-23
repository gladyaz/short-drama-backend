/**
 * Phase 11, work unit 11-B1: log redaction.
 *
 * Every log line that could carry request/exception detail must pass
 * through here before being written, so that secrets and absolute internal
 * storage paths can never leak into log output — a hard prohibition in the
 * control workspace's AGENT_RULES.md, and this phase's whole subject is
 * logging, so the redaction layer comes first and everything else builds
 * on it.
 *
 * This is deliberately a pure string transform (not an object walker):
 * callers stringify whatever context they have and redact the final text.
 * That catches secrets regardless of where they appear (a JSON field, an
 * interpolated header, a stack trace frame containing a filesystem path)
 * at the cost of being pattern-based rather than schema-aware.
 */

const REDACTED = '[REDACTED]';
const STORAGE_ROOT_PLACEHOLDER = '[STORAGE_ROOT]';

/**
 * Sensitive fields whose values must never be logged. Covers all three
 * rendering styles that actually occur in this codebase's log paths
 * (finding from this unit's independent review — the original pattern only
 * covered the first):
 *   - `"password": "value"`  — JSON.stringify output
 *   - `password: "value"`    — Prisma's pretty-printed validation errors
 *   - `password: 'value'`    — Node util.inspect / default object dumps
 * Longest-first alternation so `passwordHash`/`refreshTokenHash` match as
 * themselves, with `\b` boundaries so e.g. a hypothetical `myPassword` key
 * is matched from its embedded keyword rather than skipped entirely.
 */
const SENSITIVE_FIELD_PATTERN =
  /\b(passwordHash|password|refreshTokenHash|refreshToken|accessToken|authorization)(["']?\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

/** `Bearer <token>` wherever it appears (headers echoed into errors, etc.). */
const BEARER_TOKEN_PATTERN = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g;

export function redactSensitiveText(
  text: string,
  storageRoot: string | undefined = process.env.STORAGE_ROOT,
): string {
  let result = text;

  if (storageRoot && storageRoot.length > 1) {
    // split/join instead of a RegExp so the path needs no escaping.
    result = result.split(storageRoot).join(STORAGE_ROOT_PLACEHOLDER);
  }

  result = result.replace(SENSITIVE_FIELD_PATTERN, `$1$2"${REDACTED}"`);
  result = result.replace(BEARER_TOKEN_PATTERN, `$1${REDACTED}`);

  return result;
}
