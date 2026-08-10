import { defineConfig } from 'vitest/config';

/**
 * Slice 11Q — deliberately minimal. `environment: 'node'` (the default) is
 * exactly right here: every module under `src/` is a pure function or a
 * fetch-style handler exercised with a hand-built fake `Env`/`MediaBucket`
 * (see `test/fake-bucket.ts`) — nothing in this package needs miniflare or
 * `@cloudflare/vitest-pool-workers` to unit-test (per the 2026-08-10 Slice
 * 11Q approval: "Worker unit tests (+ local runtime if available)" — the
 * "local runtime" part is explicitly optional and not attempted here).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
