import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEST_FIXTURE_EMAIL_DOMAIN,
  TEST_FIXTURE_MARKER_PATTERN,
  TEST_FIXTURE_NAMESPACE,
  TEST_FIXTURE_NAMESPACE_PATTERN,
  fixtureEmail,
  fixtureMarker,
  uniqueFixtureMarker,
} from './fixture-namespace.helpers';
import {
  TEST_FIXTURE_REGISTRY_DIR_ENV,
  createFixtureNamespaceRegistry,
  discardFixtureNamespaceRegistry,
  readRegisteredFixtureNamespaces,
  registerTestFixtureNamespace,
} from './fixture-namespace-registry';

/**
 * Locks the two properties the stale-fixture sweep is built on top of.
 *
 * The sweep decides whether a row may be DELETED by matching its marker
 * against `TEST_FIXTURE_MARKER_PATTERN`. That makes the agreement between
 * the generator and the pattern a safety property, not a formatting detail:
 * if the pattern stopped describing what the generator produces, abandoned
 * rows would be orphaned forever (harmless) or — in the other direction —
 * rows nobody generated would become deletion candidates (not harmless at
 * all). Neither failure is visible from either file alone, so it is
 * asserted here.
 */
describe('fixture namespace', () => {
  describe('generator and pattern agree', () => {
    it('produces a namespace the whole-value pattern accepts', () => {
      expect(TEST_FIXTURE_NAMESPACE).toMatch(TEST_FIXTURE_NAMESPACE_PATTERN);
    });

    it.each([
      ['fixtureEmail', fixtureEmail('label')],
      ['fixtureMarker', fixtureMarker('label')],
      ['uniqueFixtureMarker', uniqueFixtureMarker('label')],
    ])('marks %s output with the live namespace', (_label, marker) => {
      const match = TEST_FIXTURE_MARKER_PATTERN.exec(marker);

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe(TEST_FIXTURE_NAMESPACE);
    });

    it('generates addresses only in the reserved test domain', () => {
      expect(fixtureEmail('label').endsWith(TEST_FIXTURE_EMAIL_DOMAIN)).toBe(
        true,
      );
    });

    it('recovers the namespace from a pre-padding marker, which developer databases still hold', () => {
      // `t7u0ba830e` is a real abandoned namespace from before the pid
      // segment was zero-padded. Its boundary is ambiguous without the
      // trailing hyphen the pattern requires: a two-digit reading (`7u` +
      // `0ba830`) also satisfies the character classes, and a `startsWith`
      // delete built from it would reach past the namespace that owns the
      // row.
      const match = TEST_FIXTURE_MARKER_PATTERN.exec(
        't7u0ba830e-105-as-reset@example.test',
      );

      expect(match?.[1]).toBe('t7u0ba830e');
    });
  });

  describe('rejects markers it does not own', () => {
    // Every string below exists (or plausibly exists) in the developer
    // database this sweep runs against. A match here would mean real data
    // becoming a deletion candidate.
    it.each([
      'admin@demo.local',
      'qa-admin@local.test',
      'qa-iklan@example.com',
      'qa12-1785592840103-b1@example.invalid',
      'analytics-e2e-spec+11b3-1785@example.test',
      'videos-e2e-spec+10b3-listing-1785@example.test',
      'transcode-enqueue-e2e-off-series',
      'video-104-01',
      'series-104',
      'media-qa-fixture-01',
      // Right shape, but no marker suffix: a bare name that merely opens
      // with the right characters is not a fixture.
      'tester123abc@example.test',
    ])('does not claim %s', (marker) => {
      expect(TEST_FIXTURE_MARKER_PATTERN.exec(marker)).toBeNull();
    });

    it.each([
      [''],
      ['t'],
      ['t00abczzzzzz'], // right length, but the tail is not hexadecimal
      ['t00abc1122334455'], // longer than any pid segment can make it
      ['T00ABC112233'], // uppercase: base-36 output is lowercase
      ['t00abc112233-1-label@example.test'], // a marker, not a namespace
      [' t00abc112233'],
    ])('does not accept %p as a whole namespace value', (candidate) => {
      expect(TEST_FIXTURE_NAMESPACE_PATTERN.test(candidate)).toBe(false);
    });

    it('accepts both the padded and pre-padding widths as whole values', () => {
      // Not "one canonical width": the pid segment is 1-5 base-36 digits,
      // so `t00abc112233` (padded) and `t7u0ba830e` (pre-padding) are BOTH
      // real namespaces. A pattern that only accepted the current width
      // would orphan the older ones permanently.
      expect(TEST_FIXTURE_NAMESPACE_PATTERN.test('t00abc112233')).toBe(true);
      expect(TEST_FIXTURE_NAMESPACE_PATTERN.test('t7u0ba830e')).toBe(true);
    });
  });

  describe('uniqueness within a worker', () => {
    it('never repeats an address', () => {
      const addresses = Array.from({ length: 500 }, () => fixtureEmail('same'));

      expect(new Set(addresses).size).toBe(addresses.length);
    });

    it('keeps the local part inside the RFC 5321 64-character limit', () => {
      const [localPart] = fixtureEmail(
        'a-fairly-descriptive-label-for-a-fixture',
      ).split('@');

      expect(localPart.length).toBeLessThanOrEqual(64);
    });
  });
});

/**
 * The registry is what lets `globalTeardown` clean up after the run it
 * belongs to: the namespaces are computed in worker processes that have
 * already exited by then, so the main process can only know them if the
 * workers wrote them down. Every failure mode has to be silent — a hygiene
 * mechanism must not be able to fail a gate.
 */
describe('fixture namespace registry', () => {
  const originalDirectory = process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];

  afterEach(() => {
    discardFixtureNamespaceRegistry();
    if (originalDirectory === undefined) {
      delete process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];
    } else {
      process.env[TEST_FIXTURE_REGISTRY_DIR_ENV] = originalDirectory;
    }
  });

  it('records namespaces and reads them back', () => {
    createFixtureNamespaceRegistry();

    registerTestFixtureNamespace('t00abc112233');
    registerTestFixtureNamespace('t7u0ba830e');
    registerTestFixtureNamespace('t00abc112233');

    expect(readRegisteredFixtureNamespaces().sort()).toEqual([
      't00abc112233',
      't7u0ba830e',
    ]);
  });

  it('is inert when no run published a registry', () => {
    delete process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];

    expect(() => registerTestFixtureNamespace('t00abc112233')).not.toThrow();
    expect(readRegisteredFixtureNamespaces()).toEqual([]);
  });

  it('refuses to write a name that could escape the registry directory', () => {
    const directory = createFixtureNamespaceRegistry() as string;

    for (const hostile of [
      '../escaped',
      '/etc/passwd',
      'has/slash',
      '',
      'UPPER',
      'has-hyphen',
    ]) {
      registerTestFixtureNamespace(hostile);
    }

    expect(readdirSync(directory)).toEqual([]);
  });

  it('ignores an entry that is not a well-formed namespace', () => {
    const directory = createFixtureNamespaceRegistry() as string;
    // Written directly, bypassing the writer's own validation, to prove the
    // READ side filters too — the returned values become `startsWith`
    // delete predicates.
    writeFileSync(join(directory, 'notanamespace'), '');
    registerTestFixtureNamespace('t00abc112233');

    expect(readRegisteredFixtureNamespaces()).toContain('t00abc112233');
  });

  it('discards the directory so runs do not accumulate one each', () => {
    const directory = createFixtureNamespaceRegistry() as string;
    registerTestFixtureNamespace('t00abc112233');

    discardFixtureNamespaceRegistry();

    expect(() => readdirSync(directory)).toThrow();
    expect(process.env[TEST_FIXTURE_REGISTRY_DIR_ENV]).toBeUndefined();
  });

  it('survives a registry directory that has been removed underneath it', () => {
    const directory = createFixtureNamespaceRegistry() as string;
    rmSync(directory, { recursive: true, force: true });

    expect(() => registerTestFixtureNamespace('t00abc112233')).not.toThrow();
    expect(readRegisteredFixtureNamespaces()).toEqual([]);
    expect(() => discardFixtureNamespaceRegistry()).not.toThrow();
  });

  it('does not see a concurrently running gate registry', () => {
    // Two gates (two worktrees, or unit beside e2e) each publish their own
    // directory. This is the property that makes teardown's age-free sweep
    // safe: it can only ever act on namespaces its own workers registered.
    const otherGate = mkdtempSync(join(tmpdir(), 'other-gate-'));
    writeFileSync(join(otherGate, 't00zzz998877'), '');

    createFixtureNamespaceRegistry();
    registerTestFixtureNamespace('t00abc112233');

    expect(readRegisteredFixtureNamespaces()).toEqual(['t00abc112233']);

    rmSync(otherGate, { recursive: true, force: true });
  });
});
