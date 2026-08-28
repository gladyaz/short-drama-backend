import { createGracefulShutdown } from './worker-shutdown';

/**
 * VPS DEPLOYMENT — an unattended box restarts this worker constantly, and
 * every restart sends SIGTERM to a process that may be deep inside an
 * FFmpeg encode. These tests pin the three properties that decide whether
 * that is safe or corrupting.
 */
describe('createGracefulShutdown', () => {
  function deferred(): {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function buildDeps(
    overrides: Partial<Parameters<typeof createGracefulShutdown>[0]> = {},
  ) {
    const calls: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];

    const deps = {
      closeWorker: () => {
        calls.push('closeWorker');
        return Promise.resolve();
      },
      closeApp: () => {
        calls.push('closeApp');
        return Promise.resolve();
      },
      stopJanitor: () => {
        calls.push('stopJanitor');
      },
      log: (message: string) => logs.push(message),
      logError: (message: string) => errors.push(message),
      ...overrides,
    };

    return { deps, calls, logs, errors };
  }

  it('stops the janitor, drains the worker, then closes the app, in that order', async () => {
    const { deps, calls } = buildDeps();
    const done = deferred();
    const shutdown = createGracefulShutdown(deps, done.resolve);

    shutdown('SIGTERM');
    await done.promise;

    expect(calls).toEqual(['stopJanitor', 'closeWorker', 'closeApp']);
  });

  // THE CORRUPTION-SAFETY PROPERTY. `closeWorker` is BullMQ's
  // `worker.close()` without `force`, which resolves only once the in-flight
  // job has finished. Nothing may run ahead of it, and completion may not be
  // signalled before it settles — otherwise the process would exit while a
  // job was still uploading a partial HLS generation.
  it('does not signal completion until the in-flight job has finished draining', async () => {
    const drain = deferred();
    const { deps, calls } = buildDeps({ closeWorker: () => drain.promise });
    let completed = false;
    const shutdown = createGracefulShutdown(deps, () => {
      completed = true;
    });

    shutdown('SIGTERM');
    await Promise.resolve();

    expect(calls).toEqual(['stopJanitor']);
    expect(completed).toBe(false);

    drain.resolve();
    await drain.promise;
    await new Promise((resolve) => setImmediate(resolve));

    expect(completed).toBe(true);
  });

  // Orchestrators send SIGTERM more than once, and an impatient operator
  // adds SIGINT on top. Re-entering would call close() on an already-closing
  // worker while the first drain is still running.
  it('ignores repeat signals while a shutdown is already in progress', async () => {
    const drain = deferred();
    let closeWorkerCalls = 0;
    const { deps, logs } = buildDeps({
      closeWorker: () => {
        closeWorkerCalls += 1;
        return drain.promise;
      },
    });
    const done = deferred();
    const shutdown = createGracefulShutdown(deps, done.resolve);

    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await Promise.resolve();

    expect(closeWorkerCalls).toBe(1);
    expect(
      logs.filter((line) => line.includes('already shutting down')),
    ).toHaveLength(2);

    drain.resolve();
    await done.promise;
    expect(closeWorkerCalls).toBe(1);
  });

  // THE ANTI-HANG PROPERTY. Without this, a rejected teardown leaves the
  // shutdown promise pending forever, the process never exits, and the
  // orchestrator SIGKILLs it — the exact outcome graceful shutdown exists
  // to avoid.
  it('still completes when the worker close rejects, and reports the failure', async () => {
    const { deps, calls, errors } = buildDeps({
      closeWorker: () => Promise.reject(new Error('redis went away')),
    });
    const done = deferred();
    const shutdown = createGracefulShutdown(deps, done.resolve);

    shutdown('SIGTERM');
    await done.promise;

    expect(calls).toEqual(['stopJanitor', 'closeApp']);
    expect(errors.join(' ')).toContain('redis went away');
  });

  it('still completes when the application context close rejects', async () => {
    const { deps, errors } = buildDeps({
      closeApp: () => Promise.reject(new Error('prisma disconnect failed')),
    });
    const done = deferred();
    const shutdown = createGracefulShutdown(deps, done.resolve);

    shutdown('SIGTERM');
    await done.promise;

    expect(errors.join(' ')).toContain('prisma disconnect failed');
  });

  it('still drains the worker when stopping the janitor throws', async () => {
    const { deps, calls, errors } = buildDeps({
      stopJanitor: () => {
        throw new Error('clearInterval blew up');
      },
    });
    const done = deferred();
    const shutdown = createGracefulShutdown(deps, done.resolve);

    shutdown('SIGTERM');
    await done.promise;

    expect(calls).toEqual(['closeWorker', 'closeApp']);
    expect(errors.join(' ')).toContain('clearInterval blew up');
  });
});
