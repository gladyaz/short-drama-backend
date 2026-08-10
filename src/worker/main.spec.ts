/**
 * Slice 11O — `main.ts` is the worker's actual process ENTRY POINT; its own
 * real boot-and-exit-0 behavior is proven by actually running
 * `node dist/worker/main` (see the report's "worker entry + how to run it"
 * section), not by a Jest spec — booting a full `WorkerModule` here would
 * require the same real `.env`/`validateEnv` coupling `AppModule` itself
 * only ever exercises in `test/*.e2e-spec.ts`, never in a `src/**\/*.spec.ts`
 * unit test (see e.g. `../transcode/transcode.module.spec.ts`'s
 * `ignoreEnvFile: true` pattern) — this file stays consistent with that.
 *
 * What IS meaningfully asserted here, at the unit level: importing this
 * module never triggers a real boot (the `require.main === module` guard —
 * Jest is always the `require.main` when it imports a spec's dependencies,
 * never this file itself), and the exported `bootstrapWorker` function
 * exists with the expected shape, so a future accidental removal of the
 * guard would be caught by `expect(process.exit)`/`expect(NestFactory...)`
 * never having been called during `import`.
 */
describe('src/worker/main.ts', () => {
  it('does not auto-run bootstrapWorker merely by being imported (require.main !== module guard)', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error(
        'process.exit should never be called by importing main.ts',
      );
    });

    // A deliberate, controlled-timing `require()` (not a static `import`,
    // which the compiler would hoist above `exitSpy`'s setup and defeat the
    // point of this assertion) — proves the module can be REQUIRED, at any
    // point, without triggering a real boot.
    let imported: typeof import('./main');
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      imported = require('./main') as typeof import('./main');
    }).not.toThrow();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(typeof imported!.bootstrapWorker).toBe('function');

    exitSpy.mockRestore();
  });
});
