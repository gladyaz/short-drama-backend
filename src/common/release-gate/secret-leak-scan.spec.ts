import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyLeakCandidate,
  classifyPath,
  findExemptedDeclarationRanges,
  isCommentLine,
  LeakCandidate,
  RELEASE_GATE_LEAK_EXEMPTIONS,
  runLeakScan,
  SCANNED_FILE_CLASSES,
  scanTextForLeakPatterns,
} from './secret-leak-scan';

/**
 * THE LEAK SCAN.
 *
 * Every input below is a synthetic string written in this file. Nothing here
 * reads the repository, opens a connection, or contains a real credential —
 * the "secrets" are obviously-fake literals chosen to exercise a shape.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

const candidate = (path: string, content: string): LeakCandidate | undefined =>
  scanTextForLeakPatterns(path, content)[0];

describe('leak scan — file classification', () => {
  it.each([
    ['src/config/configuration.ts', 'release-bound'],
    ['scripts/production-preflight.ts', 'release-bound'],
    ['prisma/migrations/20260101000000_x/migration.sql', 'release-bound'],
    ['workers/hls-gateway/src/token.ts', 'release-bound'],
    ['src/config/env.validation.spec.ts', 'test-support'],
    ['test/videos.e2e-spec.ts', 'test-support'],
    ['src/common/testing/test-database-guard.ts', 'test-support'],
    ['docs/V1_STAGING_RUNBOOK.md', 'documentation'],
    ['.env.production.example', 'documentation'],
    ['.github/workflows/ci.yml', 'ci-workflow'],
    ['docker-compose.yml', 'local-infrastructure'],
    ['package-lock.json', 'generated'],
    ['src/common/release-gate/release-mode.ts', 'gate-fixture'],
  ])('classifies %s as %s', (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });

  it('grades only release-bound source and CI workflows', () => {
    const leaky = "const endpoint = 'http://192.168.1.50:9000';";

    expect(scanTextForLeakPatterns('src/media/x.ts', leaky)).toHaveLength(1);
    expect(scanTextForLeakPatterns('src/media/x.spec.ts', leaky)).toEqual([]);
    expect(scanTextForLeakPatterns('docs/x.md', leaky)).toEqual([]);
    expect(scanTextForLeakPatterns('package-lock.json', leaky)).toEqual([]);
  });
});

describe('leak scan — the noise this exists to avoid', () => {
  it('ignores prose in comments', () => {
    for (const line of [
      ' * Rejects http://localhost:3000 and https://api.example.com.',
      '// a LAN address such as 192.168.1.50 is refused',
      '-- 192.168.1.50 was the old host',
      '# see http://localhost:3000',
    ]) {
      expect(isCommentLine(line)).toBe(true);
      expect(scanTextForLeakPatterns('src/x.ts', line)).toEqual([]);
    }
  });

  it('CRITICAL: does not read `PATTERN.test(value)` as a reserved .test domain', () => {
    // Without a string-context rule this false-positives in every
    // regex-using file in the repository, which is how a scanner gets
    // switched off.
    expect(
      scanTextForLeakPatterns(
        'src/series/series-cover-key.util.ts',
        '  return UUID_V4_PATTERN.test(version);',
      ),
    ).toEqual([]);
  });

  it('CRITICAL: does not read a string-enum member as a hardcoded credential', () => {
    expect(
      scanTextForLeakPatterns(
        'src/common/errors/app-error-code.ts',
        "  INVALID_REFRESH_TOKEN = 'INVALID_REFRESH_TOKEN',",
      ),
    ).toEqual([]);
    expect(
      scanTextForLeakPatterns(
        'src/common/errors/app-error-code.ts',
        "  INVALID_ACCESS_TOKEN = 'SOME_OTHER_SCREAMING_CODE',",
      ),
    ).toEqual([]);
  });

  it('reports at most one finding per line', () => {
    const found = scanTextForLeakPatterns(
      'src/x.ts',
      "const u = 'https://changeme.example.com/127.0.0.1';",
    );
    expect(found).toHaveLength(1);
  });
});

describe('leak scan — genuine production leaks', () => {
  it('BLOCKS a LAN address compiled into release-bound source', () => {
    const found = candidate(
      'src/storage/storage.module.ts',
      "  endpoint: 'http://192.168.1.50:9000',",
    )!;

    expect(found.patternId).toBe('private-network');
    expect(classifyLeakCandidate(found).verdict).toBe('LEAK');
  });

  it('BLOCKS a loopback URL compiled into release-bound source', () => {
    const found = candidate(
      'src/media/media.service.ts',
      "  const base = 'http://localhost:3000';",
    )!;

    expect(found.patternId).toBe('loopback');
    expect(classifyLeakCandidate(found).verdict).toBe('LEAK');
  });

  it('BLOCKS a reserved documentation domain used as a real value', () => {
    const found = candidate(
      'src/media/media.service.ts',
      "  const cdn = 'https://cdn.example.com';",
    )!;

    expect(found.patternId).toBe('reserved-domain');
    expect(classifyLeakCandidate(found).verdict).toBe('LEAK');
  });

  it('BLOCKS a template placeholder left in release-bound source', () => {
    const found = candidate(
      'src/rewards/rewards.service.ts',
      "  const profile = 'https://www.instagram.com/your-handle';",
    )!;

    expect(found.patternId).toBe('placeholder-word');
    expect(classifyLeakCandidate(found).verdict).toBe('LEAK');
  });

  it('CRITICAL: BLOCKS a hardcoded credential and never prints its value', () => {
    const secret = 'sk-live-0123456789abcdefghijklmnop';
    const found = candidate(
      'src/payments/midtrans/midtrans-http.client.ts',
      `  const MIDTRANS_SERVER_TOKEN = '${secret}';`,
    )!;

    expect(found.patternId).toBe('hardcoded-credential');

    const { findings } = runLeakScan([
      {
        path: 'src/payments/midtrans/midtrans-http.client.ts',
        content: `  const MIDTRANS_SERVER_TOKEN = '${secret}';`,
      },
    ]);

    const blocker = findings.find((f) => f.severity === 'BLOCKER')!;
    expect(blocker.detail).toContain('MIDTRANS_SERVER_TOKEN');
    expect(blocker.detail).toContain('value not printed');
    expect(blocker.detail).not.toContain(secret);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });
});

describe('leak scan — CI workflows', () => {
  const path = '.github/workflows/ci.yml';

  it('allows a literal CI credential that labels itself disposable', () => {
    const found = candidate(
      path,
      '      JWT_ACCESS_SECRET: ci-test-only-access-secret-not-a-real-credential',
    )!;

    const classification = classifyLeakCandidate(found);
    expect(classification.verdict).toBe('ALLOWED');
    expect(classification.category).toBe('ci-test-only-credential');
  });

  it('CRITICAL: BLOCKS a CI credential that does NOT label itself disposable', () => {
    const found = candidate(
      path,
      '      JWT_ACCESS_SECRET: aG93ZHkgdGhpcyBjb3VsZCBiZSByZWFs',
    )!;

    const classification = classifyLeakCandidate(found);
    expect(classification.verdict).toBe('LEAK');
    expect(classification.reason).toContain('encrypted repository secret');
  });

  it('allows non-credential CI infrastructure values', () => {
    const found = candidate(
      path,
      '      DATABASE_URL: postgresql://ci:ci@localhost:5432/short_drama_dev',
    )!;

    expect(classifyLeakCandidate(found).verdict).toBe('ALLOWED');
  });
});

describe('leak scan — the exemption inventory', () => {
  const TABLE = [
    'const PLACEHOLDER_LABELS = [',
    "  'changeme',",
    "  'your-handle',",
    '] as const;',
    "const leaked = 'http://192.168.9.9:3000';",
  ].join('\n');

  const path = 'src/common/production-preflight/preflight.ts';

  it('covers every member of an exempted multi-line rejection table', () => {
    const ranges = findExemptedDeclarationRanges(path, TABLE);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startLine).toBe(1);
    expect(ranges[0].endLine).toBe(4);

    for (const found of scanTextForLeakPatterns(path, TABLE)) {
      if (found.lineNumber <= 4) {
        expect(classifyLeakCandidate(found, ranges).verdict).toBe('ALLOWED');
      }
    }
  });

  it('CRITICAL: stops at the closing bracket — a leak BELOW the table still blocks', () => {
    const ranges = findExemptedDeclarationRanges(path, TABLE);
    const below = scanTextForLeakPatterns(path, TABLE).find(
      (found) => found.lineNumber === 5,
    )!;

    expect(below.patternId).toBe('private-network');
    expect(classifyLeakCandidate(below, ranges).verdict).toBe('LEAK');
  });

  it('CRITICAL: an UNTERMINATED declaration does not swallow the rest of the file', () => {
    // The span extends only while lines are MORE indented than the
    // declaration. An exemption that grew to cover code nobody reviewed
    // would be worse than no exemption at all.
    const unterminated = [
      'const PLACEHOLDER_LABELS = [',
      "  'changeme',",
      '',
      "const leaked = 'http://192.168.9.9:3000';",
    ].join('\n');

    const ranges = findExemptedDeclarationRanges(path, unterminated);
    expect(ranges[0].endLine).toBe(2);

    const below = scanTextForLeakPatterns(path, unterminated).find(
      (found) => found.lineNumber === 4,
    )!;
    expect(classifyLeakCandidate(below, ranges).verdict).toBe('LEAK');
  });

  it('CRITICAL: an exemption cannot drift onto a different line of the same file', () => {
    // The evidence substring must appear on the matched line. A brand-new
    // leak in an exempted file is therefore still reported.
    const found = candidate(
      'src/config/configuration.ts',
      "  someOtherThing: 'http://localhost:9999',",
    )!;

    expect(classifyLeakCandidate(found).verdict).toBe('LEAK');
  });

  /**
   * THE INVENTORY MUST STAY REACHABLE.
   *
   * A dead exemption is the quiet failure mode here: it reads as a reviewed
   * justification, it survives review because it looks deliberate, and it
   * covers nothing at all — either because the file class is never scanned,
   * or because the construct it anchors to was renamed. An anchor that
   * disappears is at least LOUD (the line starts blocking); an entry that was
   * never reachable is silent forever.
   *
   * Reads the real repository. Executes nothing.
   */
  it.each(
    RELEASE_GATE_LEAK_EXEMPTIONS.map((entry) => [entry.path, entry] as const),
  )(
    'CRITICAL: the exemption for %s is reachable and still anchored',
    (exemptionPath, entry) => {
      expect(SCANNED_FILE_CLASSES).toContain(classifyPath(exemptionPath));

      const absolute = join(REPO_ROOT, exemptionPath);
      expect(existsSync(absolute)).toBe(true);
      expect(readFileSync(absolute, 'utf8')).toContain(entry.evidence);
    },
  );

  it('every inventory entry states a reason and a category', () => {
    for (const entry of RELEASE_GATE_LEAK_EXEMPTIONS) {
      expect(entry.path).toMatch(/^[\w.@-]+(\/[\w.@-]+)*$/);
      expect(entry.evidence.length).toBeGreaterThan(4);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.category.length).toBeGreaterThan(2);
    }
  });
});

describe('leak scan — reporting', () => {
  it('counts allowed matches without printing each one', () => {
    const result = runLeakScan([
      {
        path: 'src/common/net/public-host.ts',
        content: "const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);",
      },
    ]);

    expect(result.leaks).toBe(0);
    expect(result.allowed).toBe(1);
    expect(result.findings.filter((f) => f.severity !== 'PASS')).toEqual([]);
    expect(result.findings[0].detail).toContain('1 match(es) classified');
  });

  it('reports a REVIEW match as a warning, never a blocker', () => {
    const result = runLeakScan([
      {
        path: 'src/config/configuration.ts',
        content:
          "    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',",
      },
    ]);

    expect(result.leaks).toBe(0);
    expect(result.reviews).toBe(1);
    expect(result.findings.some((f) => f.severity === 'WARNING')).toBe(true);
  });
});
