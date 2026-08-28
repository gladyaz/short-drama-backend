import { mkdtemp, mkdir, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveWorkerTempRoot,
  sweepStaleWorkerTempDirs,
  WorkerTempFs,
} from './transcode-temp';
import { TRANSCODE_WORKER_TEMP_DIR_PREFIX } from './transcode.constants';

/**
 * VPS DEPLOYMENT — the stale-temp sweep is the only thing standing between a
 * crash-looping worker and a full disk on an unattended box, so its
 * behavior is proven directly rather than inferred.
 *
 * The filesystem is INJECTED for the age/selection rules (a real disk cannot
 * be made to report a two-hour-old mtime without either waiting two hours or
 * mutating file times, and neither belongs in a unit test), while
 * `resolveWorkerTempRoot` is exercised against a REAL temp directory —
 * "does this actually create a missing directory" is precisely the question
 * a fake would answer trivially and uselessly.
 */
describe('sweepStaleWorkerTempDirs', () => {
  const MINUTE = 60_000;
  const NOW = 1_000 * MINUTE;

  function fakeFs(
    entries: Record<string, { ageMinutes: number }>,
    overrides: Partial<WorkerTempFs> = {},
  ): { fs: WorkerTempFs; removed: string[] } {
    const removed: string[] = [];

    const fs: WorkerTempFs = {
      readdir: () => Promise.resolve(Object.keys(entries)),
      stat: (path) => {
        const name = path.split('/').pop()!;
        const entry = entries[name];
        if (!entry) {
          return Promise.reject(new Error(`no such entry: ${name}`));
        }
        return Promise.resolve({ mtimeMs: NOW - entry.ageMinutes * MINUTE });
      },
      rm: (path) => {
        removed.push(path.split('/').pop()!);
        return Promise.resolve();
      },
      ...overrides,
    };

    return { fs, removed };
  }

  it('removes a prefix-matching directory older than the age threshold', async () => {
    const { fs, removed } = fakeFs({
      [`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}abc123`]: { ageMinutes: 180 },
    });

    const result = await sweepStaleWorkerTempDirs({
      root: '/tmp',
      minAgeMs: 120 * MINUTE,
      now: NOW,
      fs,
    });

    expect(removed).toEqual([`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}abc123`]);
    expect(result).toEqual({ removed: 1, skippedTooYoung: 0, failed: 0 });
  });

  // THE SAFETY PROPERTY. A second worker on the same box (or a second
  // container sharing a temp volume) can be mid-encode in a directory this
  // sweep can see. Deleting it would destroy a live job's working set.
  it('NEVER removes a prefix-matching directory younger than the age threshold', async () => {
    const { fs, removed } = fakeFs({
      [`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}live-job`]: { ageMinutes: 5 },
    });

    const result = await sweepStaleWorkerTempDirs({
      root: '/tmp',
      minAgeMs: 120 * MINUTE,
      now: NOW,
      fs,
    });

    expect(removed).toEqual([]);
    expect(result).toEqual({ removed: 0, skippedTooYoung: 1, failed: 0 });
  });

  // THE BLAST-RADIUS PROPERTY. `/tmp` is shared. Anything not created by
  // this pipeline's own `mkdtemp` prefix belongs to somebody else.
  it('ignores entries that do not carry the transcode temp prefix, however old', async () => {
    const { fs, removed } = fakeFs({
      'systemd-private-xyz': { ageMinutes: 100_000 },
      'someone-elses-cache': { ageMinutes: 100_000 },
      [`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}ours`]: { ageMinutes: 100_000 },
    });

    await sweepStaleWorkerTempDirs({
      root: '/tmp',
      minAgeMs: 120 * MINUTE,
      now: NOW,
      fs,
    });

    expect(removed).toEqual([`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}ours`]);
  });

  // A sweep failure must degrade, never take the worker down: this runs at
  // startup, so throwing here would turn "disk is a bit full" into "the
  // worker will not boot".
  it('continues past a per-entry failure, reports it, and never throws', async () => {
    const errors: string[] = [];
    const { fs, removed } = fakeFs(
      {
        [`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}bad`]: { ageMinutes: 180 },
        [`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}good`]: { ageMinutes: 180 },
      },
      {
        rm: (path) => {
          if (path.endsWith('bad')) {
            return Promise.reject(new Error('EACCES'));
          }
          return Promise.resolve();
        },
      },
    );
    void removed;

    const result = await sweepStaleWorkerTempDirs({
      root: '/tmp',
      minAgeMs: 120 * MINUTE,
      now: NOW,
      fs,
      onError: (message) => errors.push(message),
    });

    expect(result).toEqual({ removed: 1, skippedTooYoung: 0, failed: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('EACCES');
  });

  it('reports an unreadable root without throwing', async () => {
    const errors: string[] = [];

    const result = await sweepStaleWorkerTempDirs({
      root: '/tmp',
      minAgeMs: 120 * MINUTE,
      now: NOW,
      fs: {
        readdir: () => Promise.reject(new Error('ENOENT')),
        stat: () => Promise.reject(new Error('unreachable')),
        rm: () => Promise.reject(new Error('unreachable')),
      },
      onError: (message) => errors.push(message),
    });

    expect(result).toEqual({ removed: 0, skippedTooYoung: 0, failed: 0 });
    expect(errors[0]).toContain('ENOENT');
  });

  it('leaves an unreadable entry counted as failed rather than silently skipped', async () => {
    const result = await sweepStaleWorkerTempDirs({
      root: '/tmp',
      minAgeMs: 120 * MINUTE,
      now: NOW,
      fs: {
        readdir: () =>
          Promise.resolve([`${TRANSCODE_WORKER_TEMP_DIR_PREFIX}vanished`]),
        stat: () => Promise.reject(new Error('ENOENT')),
        rm: () => Promise.resolve(),
      },
    });

    expect(result).toEqual({ removed: 0, skippedTooYoung: 0, failed: 1 });
  });
});

describe('resolveWorkerTempRoot', () => {
  it('defaults to os.tmpdir() when nothing is configured', async () => {
    await expect(resolveWorkerTempRoot(undefined)).resolves.toBe(tmpdir());
  });

  // The reason this function exists at all: a container's configured temp
  // volume very often does not exist yet on first boot, and a missing parent
  // makes `mkdtemp` fail with an ENOENT naming a path the operator never
  // typed.
  it('creates a configured root that does not exist yet', async () => {
    const base = await mkdtemp(join(tmpdir(), 'transcode-temp-root-spec-'));
    const configured = join(base, 'nested', 'transcode-tmp');

    await expect(resolveWorkerTempRoot(configured)).resolves.toBe(configured);
    await expect(readdir(configured)).resolves.toEqual([]);
  });

  it('is idempotent against a root that already exists and keeps its contents', async () => {
    const base = await mkdtemp(join(tmpdir(), 'transcode-temp-root-spec-'));
    const configured = join(base, 'existing');
    await mkdir(configured);
    await writeFile(join(configured, 'keep-me'), 'x');

    await expect(resolveWorkerTempRoot(configured)).resolves.toBe(configured);
    await expect(readdir(configured)).resolves.toEqual(['keep-me']);
  });
});
