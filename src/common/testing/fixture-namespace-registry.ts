import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment variable naming the directory in which one Jest RUN records
 * the fixture namespaces its workers created.
 *
 * WHY A REGISTRY IS NEEDED AT ALL. `TEST_FIXTURE_NAMESPACE` is derived from
 * `process.pid`, and Jest's `globalSetup`/`globalTeardown` execute in the
 * MAIN process while every spec executes in a forked WORKER. The main
 * process therefore cannot compute — or even enumerate — the namespaces its
 * own run used: they belong to processes that have already exited by the
 * time teardown runs. Without a registry, `globalTeardown` would have
 * nothing it could safely delete, and the only remaining option would be an
 * age-based sweep, which by construction cannot reclaim rows created
 * seconds ago.
 *
 * The directory is created fresh by `globalSetup` and exported through this
 * variable, which Node propagates to each worker Jest forks afterwards. That
 * ownership is what makes `globalTeardown`'s age-free sweep safe: the only
 * namespaces it can ever act on are ones a worker of THIS run wrote there
 * itself. A concurrently running gate — another worktree, or the unit gate
 * beside the e2e gate — has its own directory and is invisible here.
 */
export const TEST_FIXTURE_REGISTRY_DIR_ENV =
  'TEST_FIXTURE_NAMESPACE_REGISTRY_DIR';

/**
 * Creates this run's registry directory and publishes it on `process.env`
 * for the workers Jest is about to fork. Returns the path, or `null` if the
 * directory could not be created — the registry is an optimization over the
 * age-based sweep, never a correctness requirement, so a read-only or full
 * temp directory degrades to "teardown reclaims nothing" rather than
 * failing the run.
 */
export function createFixtureNamespaceRegistry(): string | null {
  try {
    const directory = mkdtempSync(join(tmpdir(), 'short-drama-fixture-ns-'));
    process.env[TEST_FIXTURE_REGISTRY_DIR_ENV] = directory;
    return directory;
  } catch {
    delete process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];
    return null;
  }
}

/**
 * Records `namespace` as belonging to this run. Called once per worker, at
 * the moment `fixture-namespace.helpers.ts` is first imported — i.e. from
 * any spec that creates namespaced fixtures at all, and from no other code.
 *
 * Deliberately silent and best-effort in every failure mode. A test run must
 * not fail because a hygiene registry could not be written, and when the
 * environment variable is absent (a developer running `jest` against a
 * config without the `globalSetup` wiring, or any non-Jest import) this is a
 * no-op.
 *
 * The file NAME is the namespace and the file is empty: the set of names in
 * the directory is the entire data structure. `isSafeNamespace` keeps a
 * malformed value from ever reaching `join`.
 */
export function registerTestFixtureNamespace(namespace: string): void {
  const directory = process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];
  if (!directory || !isSafeNamespace(namespace)) {
    return;
  }

  try {
    writeFileSync(join(directory, namespace), '');
  } catch {
    // Best-effort: see this function's doc comment.
  }
}

/**
 * Every namespace workers of this run registered. Returns an empty array
 * when there is no registry, so the caller needs no special case for "the
 * run created no fixtures".
 */
export function readRegisteredFixtureNamespaces(): string[] {
  const directory = process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];
  if (!directory) {
    return [];
  }

  try {
    return readdirSync(directory).filter(isSafeNamespace);
  } catch {
    return [];
  }
}

/**
 * Removes the registry directory. Called by `globalTeardown` after its
 * sweep, so a long-lived developer machine does not accumulate one empty
 * directory per test run.
 */
export function discardFixtureNamespaceRegistry(): void {
  const directory = process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];
  if (!directory) {
    return;
  }

  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best-effort: see `registerTestFixtureNamespace`.
  } finally {
    delete process.env[TEST_FIXTURE_REGISTRY_DIR_ENV];
  }
}

/**
 * PATH safety only: whether `candidate` is a bare lowercase-alphanumeric
 * token, so that using it as a file name inside the registry directory
 * cannot escape that directory (`..`, `/`, `\`, an empty string, an
 * absolute path).
 *
 * Deliberately NOT the fixture-ownership test, and deliberately not an
 * import of `TEST_FIXTURE_NAMESPACE_PATTERN` — this module is imported BY
 * `fixture-namespace.helpers.ts`, so importing back from it would create a
 * cycle. Whether a registered name is really a generated namespace, and
 * therefore whether rows may be deleted for it, is decided in exactly one
 * place: `sweepStaleTestFixtures`, which re-validates every entry against
 * the real pattern before issuing a query.
 */
function isSafeNamespace(candidate: string): boolean {
  return /^[a-z0-9]{1,64}$/.test(candidate);
}
