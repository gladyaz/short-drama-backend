/**
 * RELEASE LEAK SCAN — "is there a development artefact wired into the code
 * this release is about to ship?"
 *
 * WHY A SCANNER AT ALL, GIVEN THE BOOT CONTRACT AND THE PREFLIGHT. Those two
 * grade CONFIGURATION: the variables handed to a process. Neither can see a
 * value COMPILED IN. `const endpoint = 'http://192.168.1.50:9000'` sets no
 * variable, trips no validator, and ships.
 *
 * THE HARD PART IS NOT FINDING MATCHES, IT IS NOT DROWNING IN THEM. A naive
 * grep for `localhost` over this repository returns dozens of hits, and every
 * single current one is legitimate — they are rejection allowlists, operator
 * error messages, prose in comments, and test fixtures. A scanner that
 * reported those would be switched off within a week, and then the one real
 * leak would ship. So this file CLASSIFIES rather than counts, in three
 * layers:
 *
 *   1. FILE CLASS. A spec, a doc, an `.env.example` and a CI workflow are
 *      graded by different rules than a file that runs in production —
 *      because they are different kinds of artefact, not because they are
 *      less important.
 *
 *   2. LINE CLASS. A match inside a comment is prose. This repository
 *      explains its security rules in long comments that necessarily quote
 *      the very strings those rules reject; treating that as a leak would
 *      punish the documentation.
 *
 *   3. A CURATED EXEMPTION INVENTORY. Every remaining match in the release-
 *      bound source is listed below WITH A STATED REASON, keyed by path and
 *      by a substring of the line itself. That last part is what keeps this
 *      honest: an exemption cannot drift onto a different line, and anything
 *      NEW is reported. The inventory is the audit trail — a reviewer can
 *      read it and disagree with a specific entry, which is impossible with a
 *      blanket ignore.
 *
 * IT NEVER PRINTS A MATCHED VALUE FOR A CREDENTIAL PATTERN. A leak report is
 * exactly the kind of output that gets pasted into a chat window, so a
 * `hardcoded-credential` finding names the file, the line number and the
 * VARIABLE, and stops there.
 */
import { LeakExemption, RELEASE_GATE_LEAK_EXEMPTIONS } from './leak-exemptions';
import { GateFinding } from './release-gate.types';

// Re-exported so callers (and the spec) have one import site for the scan,
// while the reviewed inventory keeps its own file.
export type { ExemptionVerdict, LeakExemption } from './leak-exemptions';
export { RELEASE_GATE_LEAK_EXEMPTIONS };

export type LeakPatternId =
  | 'loopback'
  | 'private-network'
  | 'reserved-domain'
  | 'placeholder-word'
  | 'dev-affordance'
  | 'hardcoded-credential';

/**
 * What kind of artefact a file is. Decides which rules apply, and is the
 * first thing printed beside any finding.
 */
export type LeakFileClass =
  /** Runs, or is deployed, in production. Graded strictly. */
  | 'release-bound'
  /** Specs, e2e suites and the shared test helpers under `src/common/testing`. */
  | 'test-support'
  /** Markdown, and the `.env*.example` templates whose whole job is to show placeholders. */
  | 'documentation'
  /** `.github/**` — literal, throwaway, self-labelled test-only credentials by design. */
  | 'ci-workflow'
  /** `docker-compose.yml` and friends: a developer's local machine, never deployed. */
  | 'local-infrastructure'
  /** Lockfiles and generated output — dependency metadata, not authored source. */
  | 'generated'
  /**
   * The release gate's own machinery. `secret-leak-scan.ts` necessarily
   * contains every pattern it searches for, and `release-mode.ts`
   * necessarily contains a complete synthetic configuration. Scanning them
   * would report the rules as violations of themselves.
   */
  | 'gate-fixture';

export interface LeakCandidate {
  /** Repo-relative path, POSIX separators. */
  readonly path: string;
  readonly fileClass: LeakFileClass;
  readonly lineNumber: number;
  /** The full source line, trimmed. Never rendered for credential patterns. */
  readonly line: string;
  readonly patternId: LeakPatternId;
  /** The exact substring that matched. */
  readonly matched: string;
}

export type LeakVerdict = 'ALLOWED' | 'REVIEW' | 'LEAK';

export interface LeakClassification {
  readonly verdict: LeakVerdict;
  /** Short category name, printed so a reader can group a report at a glance. */
  readonly category: string;
  /** Why this match is, or is not, a production leak. */
  readonly reason: string;
}
/**
 * The patterns. Ordered most-specific-first so a line that is really a
 * hardcoded credential is not reported as a mere placeholder word.
 *
 * `requiresStringContext` exists for one concrete false positive: TypeScript's
 * `RegExp.prototype.test` makes `SOME_PATTERN.test(value)` look like a
 * `.test` reserved TLD in every regex-using file in the repository. Requiring
 * the match to sit inside a quoted string, or after a `://`, removes that
 * entire class without weakening the rule for any real hostname.
 */
interface LeakPattern {
  readonly id: LeakPatternId;
  readonly regex: RegExp;
  readonly requiresStringContext: boolean;
  /** Verdict when no exemption covers the match. */
  readonly unexemptedVerdict: LeakVerdict;
  readonly category: string;
  readonly reason: string;
  /** True when a finding must never echo the matched text. */
  readonly redactMatch: boolean;
  /**
   * A pattern-level false-positive rule, applied before any exemption is
   * consulted.
   *
   * IT IS DELIBERATELY NOT AN EXEMPTION. An exemption says "this specific
   * line was reviewed"; this says "this SHAPE is never a leak, anywhere",
   * and encoding it here means it does not have to be re-reviewed once per
   * occurrence. `AppErrorCode.INVALID_CREDENTIALS = 'INVALID_CREDENTIALS'`
   * is the motivating case: a credential-shaped NAME assigned its own name,
   * of which this repository has dozens and will have more.
   */
  readonly isFalsePositive?: (match: RegExpExecArray) => boolean;
  /**
   * The form to use in `.yml`/`.yaml`, where a value needs no quotes at all
   * (`JWT_ACCESS_SECRET: some-value`). Without it the credential rule would
   * silently never fire on a CI workflow — the one file class where a real
   * secret is most likely to be pasted by hand.
   *
   * Its capture groups MUST match the code form's: 1 = the variable name,
   * 3 = the value, so `isFalsePositive` reads the same indices either way.
   */
  readonly yamlRegex?: RegExp;
}

/**
 * A string-enum member or a mirrored constant: the assigned literal is itself
 * a SCREAMING_SNAKE_CASE identifier. A real credential is not spelled that
 * way, and a wire-protocol error code always is.
 */
function isIdentifierMirror(match: RegExpExecArray): boolean {
  const key = match[1];
  const value = match[3];

  if (value === undefined) {
    return false;
  }

  return value === key || /^[A-Z][A-Z0-9_]*$/.test(value);
}

/**
 * Credential-shaped assignment: a variable whose NAME reads like a secret,
 * assigned a quoted literal long enough not to be a flag or an enum member.
 */
const CREDENTIAL_KEY =
  '[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESSKEY|ACCESS_KEY|PRIVATEKEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*';

export const LEAK_PATTERNS: readonly LeakPattern[] = [
  {
    id: 'hardcoded-credential',
    regex: new RegExp(
      `\\b(${CREDENTIAL_KEY})\\s*[:=]\\s*(['"\`])([^'"\`]{12,})\\2`,
      'i',
    ),
    yamlRegex: new RegExp(
      `^\\s*(${CREDENTIAL_KEY})\\s*:\\s*()([^\\s#'"][^\\s#]{11,})\\s*$`,
      'i',
    ),
    requiresStringContext: false,
    isFalsePositive: isIdentifierMirror,
    unexemptedVerdict: 'LEAK',
    category: 'hardcoded-credential',
    reason:
      'A credential-shaped name assigned a literal string. Secrets belong in ' +
      'the environment, never in source.',
    redactMatch: true,
  },
  {
    id: 'private-network',
    regex:
      /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    requiresStringContext: false,
    unexemptedVerdict: 'LEAK',
    category: 'private-network-address',
    reason:
      'A private/LAN address compiled into release-bound source. It is ' +
      'reachable from the developer machine it was typed on and from nowhere ' +
      'a user will ever be.',
    redactMatch: false,
  },
  {
    id: 'loopback',
    regex: /(?:\blocalhost\b|\b127\.0\.0\.1\b|(?<![\w:])::1(?![\w:]))/,
    requiresStringContext: true,
    unexemptedVerdict: 'LEAK',
    category: 'loopback-address',
    reason:
      'A loopback host compiled into release-bound source. On a container it ' +
      'resolves to that container, not to anything a client can reach.',
    redactMatch: false,
  },
  {
    id: 'reserved-domain',
    regex:
      /\b(?:example\.(?:com|net|org)|[a-z0-9-]+\.(?:invalid|localhost)|[a-z0-9-]+\.test\b(?!\s*\())/i,
    requiresStringContext: true,
    unexemptedVerdict: 'LEAK',
    category: 'reserved-domain',
    reason:
      'An RFC 2606/6761 reserved documentation domain. It is a valid URL and ' +
      'resolves to nothing anyone owns.',
    redactMatch: false,
  },
  {
    id: 'placeholder-word',
    regex:
      /\b(?:changeme|change-me|change_me|your-domain|yourdomain|your-handle|yourhandle|your-account|youraccount|placeholder-secret|replace-me)\b/i,
    requiresStringContext: true,
    unexemptedVerdict: 'LEAK',
    category: 'template-placeholder',
    reason:
      'A template placeholder left in release-bound source. It passes every ' +
      'shape rule and points at nothing.',
    redactMatch: false,
  },
  {
    id: 'dev-affordance',
    // Case-INSENSITIVE on purpose: `Fake WhatsApp OTP issued` and
    // `LocalFakeWhatsAppOtpProvider` are exactly the shapes worth seeing, and
    // a case-sensitive rule would have found neither.
    regex: /\b(?:devCode|devToken|fake|stubbed)\b/i,
    requiresStringContext: false,
    unexemptedVerdict: 'REVIEW',
    category: 'development-affordance',
    reason:
      'A development affordance in release-bound source. Legitimate when a ' +
      'boot guard makes it unreachable in production — worth a human look ' +
      'when it is new.',
    redactMatch: false,
  },
];

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\/|\*|#|--)/;

/** True when the whole line is prose rather than executable code. */
export function isCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line);
}

export function classifyPath(path: string): LeakFileClass {
  const normalised = path.replace(/\\/g, '/');

  if (normalised.startsWith('src/common/release-gate/')) {
    return 'gate-fixture';
  }
  if (normalised.startsWith('.github/')) {
    return 'ci-workflow';
  }
  if (
    /\.spec\.ts$/.test(normalised) ||
    /\.e2e-spec\.ts$/.test(normalised) ||
    normalised.startsWith('test/') ||
    normalised.startsWith('src/common/testing/')
  ) {
    return 'test-support';
  }
  if (
    /\.mdx?$/i.test(normalised) ||
    normalised.startsWith('docs/') ||
    /(^|\/)\.env[^/]*\.example$/.test(normalised) ||
    /\.example$/.test(normalised)
  ) {
    return 'documentation';
  }
  if (
    normalised === 'docker-compose.yml' ||
    normalised === 'docker-compose.yaml'
  ) {
    return 'local-infrastructure';
  }
  if (
    normalised.endsWith('package-lock.json') ||
    normalised.startsWith('dist/') ||
    normalised.includes('node_modules/')
  ) {
    return 'generated';
  }
  return 'release-bound';
}

/**
 * The file classes whose contents are actually graded. Everything else is
 * COUNTED (so the report can say how much was considered) but never blocks.
 */
export const SCANNED_FILE_CLASSES: readonly LeakFileClass[] = [
  'release-bound',
  'ci-workflow',
];

/** Whether the index sits inside a quoted string, or immediately after `://`. */
function hasStringContext(line: string, index: number): boolean {
  if (/:\/\/[^\s'"`]*$/.test(line.slice(0, index + 1))) {
    return true;
  }

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = 0; i < index; i += 1) {
    const char = line[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (char === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (char === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
  }

  return inSingle || inDouble || inBacktick;
}

/**
 * YAML has no quoting requirement, so a bare scalar (`JWT_SECRET: abc123`) is
 * still a value. String context is therefore not required for `.yml`/`.yaml`
 * or `.sql`.
 */
function requiresStringContextFor(path: string, pattern: LeakPattern): boolean {
  if (/\.(ya?ml|sql|json)$/i.test(path)) {
    return false;
  }
  return pattern.requiresStringContext;
}

/**
 * Finds every gradeable match in one file's text.
 *
 * Comment lines are skipped for every class except CI workflows, where `#` is
 * also how a real value can be commented out beside a live one — but a
 * commented-out CI value grants nothing either, so they are skipped there too.
 */
export function scanTextForLeakPatterns(
  path: string,
  content: string,
): LeakCandidate[] {
  const fileClass = classifyPath(path);

  if (!SCANNED_FILE_CLASSES.includes(fileClass)) {
    return [];
  }

  const candidates: LeakCandidate[] = [];
  const lines = content.split('\n');

  lines.forEach((rawLine, index) => {
    if (isCommentLine(rawLine)) {
      return;
    }

    const isYaml = /\.(ya?ml)$/i.test(path);

    for (const pattern of LEAK_PATTERNS) {
      const regex =
        isYaml && pattern.yamlRegex ? pattern.yamlRegex : pattern.regex;
      const match = regex.exec(rawLine);
      if (match === null) {
        continue;
      }

      // `${{ secrets.X }}` and `${X}` are REFERENCES to a value held
      // elsewhere — an encrypted repository secret or a shell variable. They
      // are the correct thing to see in a workflow, not a leak.
      if (match[3] !== undefined && /^\$\{/.test(match[3])) {
        continue;
      }

      if (
        requiresStringContextFor(path, pattern) &&
        !hasStringContext(rawLine, match.index)
      ) {
        continue;
      }

      if (pattern.isFalsePositive?.(match)) {
        continue;
      }

      candidates.push({
        path,
        fileClass,
        lineNumber: index + 1,
        line: rawLine.trim(),
        patternId: pattern.id,
        matched: match[0],
      });

      // One finding per line. A line that is both a placeholder and a
      // loopback address is one problem, and reporting it twice teaches a
      // reader that the count is not meaningful.
      break;
    }
  });

  return candidates;
}

/**
 * The line range a `spansDeclaration` exemption actually covers.
 *
 * The declaration ends at the first line, at or below the declaration's own
 * indentation, that closes it — `];`, `] as const;`, `});`, `}`. Bounding it
 * that way is what keeps the exemption from swallowing the rest of the file:
 * a leak added below the table is outside the range and is still reported.
 */
export interface ExemptedDeclarationRange {
  readonly exemption: LeakExemption;
  readonly startLine: number;
  readonly endLine: number;
}

const DECLARATION_CLOSE = /^\s*(?:\]|\})(?:\s+as\s+const)?\s*[;,)]?\s*;?\s*$/;

export function findExemptedDeclarationRanges(
  path: string,
  content: string,
): ExemptedDeclarationRange[] {
  const spanning = RELEASE_GATE_LEAK_EXEMPTIONS.filter(
    (entry) => entry.path === path && entry.spansDeclaration,
  );

  if (spanning.length === 0) {
    return [];
  }

  const lines = content.split('\n');
  const ranges: ExemptedDeclarationRange[] = [];

  for (const exemption of spanning) {
    lines.forEach((line, index) => {
      if (!line.includes(exemption.evidence)) {
        return;
      }

      const indent = line.length - line.trimStart().length;
      let endLine = index + 1;

      // Extend only while lines are MORE INDENTED than the declaration —
      // that is what a member of it looks like. The first line back at the
      // declaration's own indent ends the span: it is either the closing
      // bracket (included) or the next statement (excluded).
      //
      // BOUNDED BY CONSTRUCTION, deliberately. An earlier version extended on
      // every non-closing line, which meant an unterminated declaration
      // silently exempted the rest of the file — an exemption that grows to
      // cover code nobody reviewed is worse than no exemption at all.
      for (let i = index + 1; i < lines.length; i += 1) {
        const candidate = lines[i];

        if (candidate.trim().length === 0) {
          continue;
        }

        const candidateIndent = candidate.length - candidate.trimStart().length;

        if (candidateIndent > indent) {
          endLine = i + 1;
          continue;
        }

        if (DECLARATION_CLOSE.test(candidate)) {
          endLine = i + 1;
        }
        break;
      }

      ranges.push({ exemption, startLine: index + 1, endLine });
    });
  }

  return ranges;
}

/**
 * Markers that make a CI credential self-evidently disposable. A CI workflow
 * legitimately carries literal throwaway values; what must never appear there
 * is a value that does NOT say so.
 */
const CI_TEST_ONLY_MARKERS = [
  'test-only',
  'test_only',
  'not-a-real',
  'not_a_real',
  'ci_local',
  'ci-local',
  'throwaway',
  'dummy',
];

export function classifyLeakCandidate(
  candidate: LeakCandidate,
  declarationRanges: readonly ExemptedDeclarationRange[] = [],
): LeakClassification {
  const pattern = LEAK_PATTERNS.find((p) => p.id === candidate.patternId)!;

  if (candidate.fileClass === 'ci-workflow') {
    return classifyCiWorkflowCandidate(candidate, pattern);
  }

  const exemption =
    RELEASE_GATE_LEAK_EXEMPTIONS.find(
      (entry) =>
        entry.path === candidate.path &&
        !entry.spansDeclaration &&
        candidate.line.includes(entry.evidence),
    ) ??
    declarationRanges.find(
      (range) =>
        candidate.lineNumber >= range.startLine &&
        candidate.lineNumber <= range.endLine,
    )?.exemption;

  if (exemption) {
    return {
      verdict: exemption.verdict ?? 'ALLOWED',
      category: exemption.category,
      reason: exemption.reason,
    };
  }

  return {
    verdict: pattern.unexemptedVerdict,
    category: pattern.category,
    reason: pattern.reason,
  };
}

/**
 * CI workflows are held to ONE rule, and it is a strong one: a credential-
 * shaped value must SAY that it is disposable. `ci-test-only-…-not-a-real-
 * credential` is fine; an opaque string that might be a real key is not,
 * because nobody reviewing the diff could tell the difference.
 *
 * Non-credential patterns (a `localhost` service host, a documentation
 * domain) are expected in a workflow that stands up its own throwaway
 * Postgres, and are allowed.
 */
function classifyCiWorkflowCandidate(
  candidate: LeakCandidate,
  pattern: LeakPattern,
): LeakClassification {
  if (candidate.patternId !== 'hardcoded-credential') {
    return {
      verdict: 'ALLOWED',
      category: 'ci-infrastructure',
      reason:
        'A CI workflow value. The runner stands up its own throwaway ' +
        'services; nothing here is reachable from, or deployed to, anywhere.',
    };
  }

  const lowered = candidate.line.toLowerCase();
  const selfLabelled = CI_TEST_ONLY_MARKERS.some((marker) =>
    lowered.includes(marker),
  );

  if (selfLabelled) {
    return {
      verdict: 'ALLOWED',
      category: 'ci-test-only-credential',
      reason:
        'A literal CI credential that labels itself disposable in its own ' +
        'value, so a reviewer can tell at a glance that it grants nothing.',
    };
  }

  return {
    verdict: 'LEAK',
    category: pattern.category,
    reason:
      'A credential-shaped value in a CI workflow that does NOT label itself ' +
      'test-only. Either mark it (for example "ci-test-only-…-not-a-real-' +
      'credential") or move it to an encrypted repository secret.',
  };
}

export interface LeakScanInput {
  readonly path: string;
  readonly content: string;
}

export interface LeakScanResult {
  readonly findings: GateFinding[];
  readonly leaks: number;
  readonly reviews: number;
  readonly allowed: number;
  readonly filesScanned: number;
}

/**
 * Scans every supplied file and renders the classified result.
 *
 * ALLOWED matches are NOT rendered individually — a report that printed
 * thirty justified lines every run would train its reader to skim. They are
 * counted, and the count is stated, which is the honest middle ground: the
 * reader knows the scanner looked, and can read the inventory in this file
 * when they want the detail.
 */
export function runLeakScan(files: readonly LeakScanInput[]): LeakScanResult {
  const graded: Array<{
    candidate: LeakCandidate;
    classification: LeakClassification;
  }> = [];

  let filesScanned = 0;

  for (const file of files) {
    if (!SCANNED_FILE_CLASSES.includes(classifyPath(file.path))) {
      continue;
    }
    filesScanned += 1;

    const declarationRanges = findExemptedDeclarationRanges(
      file.path,
      file.content,
    );

    for (const candidate of scanTextForLeakPatterns(file.path, file.content)) {
      graded.push({
        candidate,
        classification: classifyLeakCandidate(candidate, declarationRanges),
      });
    }
  }

  const findings: GateFinding[] = [];
  const leaks = graded.filter((g) => g.classification.verdict === 'LEAK');
  const reviews = graded.filter((g) => g.classification.verdict === 'REVIEW');
  const allowed = graded.filter((g) => g.classification.verdict === 'ALLOWED');

  for (const { candidate, classification } of leaks) {
    findings.push({
      severity: 'BLOCKER',
      check: `leak: ${classification.category}`,
      detail: `${candidate.path}:${candidate.lineNumber} — ${renderEvidence(
        candidate,
      )} ${classification.reason}`,
    });
  }

  for (const { candidate, classification } of reviews) {
    findings.push({
      severity: 'WARNING',
      check: `leak review: ${classification.category}`,
      detail: `${candidate.path}:${candidate.lineNumber} — ${renderEvidence(
        candidate,
      )} ${classification.reason}`,
    });
  }

  findings.push({
    severity: 'PASS',
    check: 'leak scan coverage',
    detail:
      `${filesScanned} release-bound/CI file(s) scanned against ` +
      `${LEAK_PATTERNS.length} pattern(s). ${allowed.length} match(es) ` +
      'classified as legitimate by the reviewed inventory in ' +
      'src/common/release-gate/secret-leak-scan.ts.',
  });

  return {
    findings,
    leaks: leaks.length,
    reviews: reviews.length,
    allowed: allowed.length,
    filesScanned,
  };
}

/**
 * The evidence half of a finding. For a credential pattern this is the
 * variable NAME and nothing else — never the value, and never the line.
 */
function renderEvidence(candidate: LeakCandidate): string {
  const pattern = LEAK_PATTERNS.find((p) => p.id === candidate.patternId)!;

  if (pattern.redactMatch) {
    const name = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/.exec(candidate.line)?.[1];
    return `${name ?? 'a credential-shaped name'} is assigned a literal value (value not printed).`;
  }

  return `${JSON.stringify(candidate.matched)} in \`${candidate.line.slice(0, 100)}\`.`;
}
