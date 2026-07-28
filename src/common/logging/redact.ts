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
 *
 * Phase 12, work unit 12A-B4 (redaction/secret-leak verification pass):
 * generalized from an explicit list of exact key names to a
 * KEYWORD-SUBSTRING match against the whole key identifier, so any current
 * or future sensitive key is redacted without a hand-added entry per key —
 * env-style (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
 * `AUTH_AUDIT_IP_HASH_SECRET`, `DATABASE_URL`/`DATABASE_URL_TEST`,
 * `OBJECT_STORAGE_ACCESS_KEY_ID`/`OBJECT_STORAGE_SECRET_ACCESS_KEY`),
 * camelCase (`jwtAccessSecret`, `databaseUrl`, `resetToken`), or compound
 * (`passwordHash`, `refreshTokenHash`, `authAuditIpHashSecret`) all match —
 * including a key this codebase does not have yet (e.g. work unit 12B-B3's
 * future `resetToken`/`PasswordResetToken`), since the match is driven by
 * the keyword appearing anywhere in the identifier, not a fixed list. `\b`
 * anchors the match to the start of an identifier (never mid-word); the
 * greedy `[A-Za-z0-9_]*` wrappers let a keyword appear anywhere inside a
 * longer identifier; `access_?key`/`database_?url` tolerate the optional
 * underscore SNAKE_CASE env-var names use that camelCase names don't
 * (`OBJECT_STORAGE_ACCESS_KEY_ID` vs. `accessKeyId`).
 */
const SENSITIVE_FIELD_PATTERN =
  /\b([A-Za-z0-9_]*(?:password|secret|token|hash|authorization|database_?url|access_?key)[A-Za-z0-9_]*)(["']?\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

/** `Bearer <token>` wherever it appears (headers echoed into errors, etc.). */
const BEARER_TOKEN_PATTERN = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g;

/**
 * Strips `user:password@` credentials embedded directly in a connection
 * string (e.g. a raw `DATABASE_URL`/`DATABASE_URL_TEST` value such as
 * `postgresql://USER:PASSWORD@host:5433/db`), independent of whether a
 * `databaseUrl`-shaped key precedes it in the logged text. Defense in depth
 * for Phase 12, work unit 12A-B4, for the case where a connection string
 * reaches a log/error line without going through the key-based pattern
 * above (e.g. a third-party driver's own error message). Scheme/host/port/
 * database name are left visible (useful for debugging, not sensitive);
 * only the `user:password@` segment is replaced.
 */
const URI_CREDENTIALS_PATTERN =
  /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/g;

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
  result = result.replace(URI_CREDENTIALS_PATTERN, `$1${REDACTED}@`);
  result = result.replace(BEARER_TOKEN_PATTERN, `$1${REDACTED}`);

  return result;
}
