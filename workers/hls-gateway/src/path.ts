/**
 * Slice 11Q — path/prefix security (LOAD-BEARING, per the 2026-08-10
 * approval's binding constraint 5: "Prefix/path security is LOAD-BEARING:
 * derive the allowed immutable prefix from the token, normalize safely,
 * reject traversal (.. / encoded / slash / Unicode tricks); never accept a
 * raw arbitrary R2 key").
 *
 * `normalizeRelativePath` is deliberately conservative rather than
 * merely "traversal-safe": it accepts ONLY a clean `a/b/c.ext`-shaped
 * relative path built from a small allowlisted character set
 * (`[A-Za-z0-9._-]` per segment) — this single allowlist is what actually
 * makes every one of the specific attack classes below unreachable, not a
 * denylist trying to enumerate every dangerous sequence:
 *
 * 1. Percent-decode the raw segment EXACTLY ONCE (never recursively).
 * 2. Reject a decode failure (malformed `%` escape) outright.
 * 3. Reject any backslash, null byte, or other C0/DEL control character.
 * 4. Unicode-normalize the decoded string to NFC, then re-run the same
 *    checks against the NORMALIZED string (never trust pre-normalization
 *    safety — normalization can change which bytes are present).
 * 5. Reject a leading `/` (this must be a RELATIVE path).
 * 6. Reject any remaining literal `%2e`/`%2f`/`%5c` substring
 *    (case-insensitive) — this is what catches DOUBLE-encoding
 *    (`%252e%252e%252f`, which single-decodes to the literal string
 *    `%2e%2e%2f`, not to `../`).
 * 7. Split on `/` and reject any component that is empty (a `//`) or
 *    consists ENTIRELY of dots (`.`, `..`, `...`, and so on) — not just the
 *    literal `.`/`..` special cases, as defense-in-depth against any
 *    pure-dots segment some future filesystem/tool might special-case.
 * 8. Reject any component containing a character outside
 *    `[A-Za-z0-9._-]` — this is the actual traversal-proof mechanism: `/`
 *    and `\` cannot appear WITHIN a component (they cannot survive step
 *    6/7 or this allowlist either way), and no Unicode homoglyph/
 *    compatibility trick (fullwidth solidus, etc.) can ever pass, because
 *    NFC does not fold compatibility variants to ASCII (that is NFKC,
 *    deliberately not used here) and the allowlist rejects non-ASCII
 *    outright regardless.
 */

const RESIDUAL_ENCODED_TRAVERSAL_PATTERN = /%2e|%2f|%5c/i;
const SEGMENT_ALLOWED_CHARS_PATTERN = /^[A-Za-z0-9._-]+$/;
/**
 * Matches a segment consisting ENTIRELY of one or more dots (`.`, `..`,
 * `...`, etc.) — reviewer-recommended defense-in-depth (LOW finding,
 * fix cycle 1): the literal `.`/`..` checks alone under-reject compared to
 * this module's own doc-comment claim above (point 7), since a segment like
 * `...` passes the `[A-Za-z0-9._-]` allowlist but is still a pure-dots
 * segment with no real traversal meaning of its own.
 */
const PURE_DOTS_SEGMENT_PATTERN = /^\.+$/;

/** C0 control characters (0x00-0x1F) and DEL (0x7F). */
function containsControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isCleanDecodedPath(decoded: string): boolean {
  if (decoded.length === 0) {
    return false;
  }
  if (decoded.includes('\\')) {
    return false;
  }
  if (containsControlCharacters(decoded)) {
    return false;
  }
  if (decoded.startsWith('/')) {
    return false;
  }
  if (RESIDUAL_ENCODED_TRAVERSAL_PATTERN.test(decoded)) {
    return false;
  }
  return true;
}

function segmentsAreClean(decoded: string): string[] | null {
  const segments = decoded.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      PURE_DOTS_SEGMENT_PATTERN.test(segment) ||
      !SEGMENT_ALLOWED_CHARS_PATTERN.test(segment)
    ) {
      return null;
    }
  }
  return segments;
}

/**
 * Returns a clean `a/b/c.ext` relative path, or `null` for ANY
 * malformed/unsafe input (percent-decode failure, traversal in any of its
 * encoded/double-encoded/Unicode-adjacent forms, absolute path, control
 * characters, backslashes, empty result). Never throws.
 */
export function normalizeRelativePath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  let decodedOnce: string;
  try {
    decodedOnce = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-escape — fail closed, never partially decode.
  }

  if (!isCleanDecodedPath(decodedOnce)) {
    return null;
  }

  // Re-check AFTER normalization too — never assume pre-normalization
  // safety implies post-normalization safety (binding requirement).
  const normalized = decodedOnce.normalize('NFC');
  if (!isCleanDecodedPath(normalized)) {
    return null;
  }

  const segments = segmentsAreClean(normalized);
  if (!segments) {
    return null;
  }

  return segments.join('/');
}

/**
 * Concatenates the token's authorized prefix with an ALREADY-normalized
 * relative path (never call this with a raw/un-normalized `rel`). The
 * `startsWith` assertion below is deliberate belt-and-suspenders: plain
 * string concatenation (never `Array.prototype.join` via a path-joining
 * utility, and NEVER Node's `path.join`/`path.resolve`, which collapse
 * `..` segments and could silently "fix up" a traversal attempt into a
 * DIFFERENT, still out-of-prefix key rather than rejecting it) means the
 * result is structurally guaranteed to start with `prefix` today — this
 * assertion exists so a future refactor that changes HOW the key is built
 * cannot silently reintroduce a prefix-escape without a test catching it
 * here first.
 */
export function buildObjectKey(prefix: string, rel: string): string | null {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    return null;
  }
  if (typeof rel !== 'string' || rel.length === 0) {
    return null;
  }

  const key = `${prefix}${rel}`;
  if (!key.startsWith(prefix)) {
    return null;
  }

  return key;
}
