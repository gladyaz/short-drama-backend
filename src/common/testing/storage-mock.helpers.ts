import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../../storage/storage.constants';
import {
  CreatePresignedGetUrlOptions,
  CreatePresignedPutUrlOptions,
  PresignedUrlResult,
} from '../../storage/storage.types';

/**
 * The synthetic origin every `StorageService` mock in this repository signs
 * against. Deliberately the SAME literal the existing specs already use
 * (`videos.service.spec.ts`, `admin-media.service.spec.ts`,
 * `storage.service.spec.ts`, ...) rather than a second, competing
 * convention — this file extracts that shared literal, it does not
 * introduce a new one.
 *
 * `.test` is an IANA-reserved TLD that can never resolve, so a mock that
 * accidentally escapes into real code fails loudly at DNS instead of
 * silently reaching a real bucket. No real R2 host, bucket name, or
 * credential ever appears here, and this whole directory is excluded from
 * the production build (`tsconfig.build.json` -> `src/**\/testing/**`), so
 * nothing in it can leak into `dist/`.
 */
export const SYNTHETIC_SIGNED_URL_ORIGIN = 'https://signed.example.test';

/**
 * Fixed clock for synthetic `expiresAt` values. A constant (rather than
 * `Date.now()`) keeps a mocked presign fully deterministic: two runs of the
 * same test produce byte-identical results, and a failure message is stable
 * and greppable. No Series test asserts on a GET `expiresAt` value; the
 * field exists because `PresignedUrlResult` requires it.
 */
const SYNTHETIC_SIGNING_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * The synthetic signed GET URL for `key` — a pure function of the key, so a
 * test can assert the exact URL it expects for its OWN fixture's key without
 * caring how many other rows were signed in the same call, or in what order.
 *
 * This is what makes the default mock below safe: `mockResolvedValueOnce`
 * hands its value to whichever key is signed FIRST, which for any service
 * that enumerates a whole table (`SeriesService.list`,
 * `PublicSeriesService.list`) is not necessarily the caller's own fixture.
 */
export function syntheticSignedGetUrlFor(key: string): string {
  return `${SYNTHETIC_SIGNED_URL_ORIGIN}/get?key=${encodeURIComponent(key)}`;
}

/** The full `PresignedUrlResult` a mocked `createPresignedGetUrl` returns. */
export function syntheticPresignedGetUrl(
  key: string,
  options?: CreatePresignedGetUrlOptions,
): PresignedUrlResult {
  const expiresInSeconds =
    options?.expiresInSeconds ?? DEFAULT_GET_URL_EXPIRY_SECONDS;

  return {
    url: syntheticSignedGetUrlFor(key),
    key,
    expiresAt: new Date(SYNTHETIC_SIGNING_EPOCH_MS + expiresInSeconds * 1000),
  };
}

/**
 * A `createPresignedGetUrl` mock with a DETERMINISTIC DEFAULT for any valid
 * key.
 *
 * WHY THIS EXISTS (Series test-isolation slice). `StorageService` mocks in
 * this repo were written as a bare `jest.fn()` plus a per-test
 * `mockResolvedValueOnce`. That is safe only while the service under test
 * signs exactly the keys the test created. It is NOT safe for
 * `SeriesService.list` / `PublicSeriesService.list`, which enumerate EVERY
 * `Series` row in the database — including the developer database's four
 * real curated rows. The moment those rows gained a non-null
 * `coverImageKey` (work unit "SERIES COVER UPLOAD BACKEND CONTRACT"), an
 * un-defaulted mock returned `undefined` for them and
 * `resolveSeriesCoverUrl` threw `TypeError: Cannot read properties of
 * undefined (reading 'url')` — 12 deterministic failures in
 * `series-public.service.spec.ts` that had nothing to do with the behavior
 * under test.
 *
 * The production branch is correct and unchanged: `coverImageKey != null`
 * MUST be signed. The defect was that the mock had no answer for a key it
 * did not anticipate. A default fixes the mock boundary without weakening
 * the branch, and without the alternative non-fixes: returning `undefined`,
 * hardcoding a real R2 URL, calling real storage, or stripping
 * `coverImageKey` off fixtures to dodge the branch entirely.
 *
 * Individual tests may still override it (`mockRejectedValueOnce` for a
 * signing failure, `mockResolvedValueOnce` for a specific URL) — see
 * `resetPresignedGetUrlMock` for restoring the default afterwards.
 */
export function createPresignedGetUrlMock(): jest.Mock {
  return jest
    .fn()
    .mockImplementation((key: string, options?: CreatePresignedGetUrlOptions) =>
      Promise.resolve(syntheticPresignedGetUrl(key, options)),
    );
}

/**
 * Restores `createPresignedGetUrlMock`'s default implementation AND clears
 * recorded calls — for an `afterEach`, so neither a queued
 * `mockResolvedValueOnce` nor a `mockRejectedValueOnce` installed by one
 * test can leak into the next. `mockReset()` alone would strip the default
 * back to `undefined`, reintroducing the exact crash this file prevents.
 */
export function resetPresignedGetUrlMock(mock: jest.Mock): void {
  mock.mockReset();
  mock.mockImplementation(
    (key: string, options?: CreatePresignedGetUrlOptions) =>
      Promise.resolve(syntheticPresignedGetUrl(key, options)),
  );
}

/**
 * A `createPresignedPutUrl` mock that echoes the REAL key argument back,
 * mirroring `StorageService.createPresignedPutUrl`'s actual behavior — the
 * cover-upload tests assert that `upload.key` is the server-generated key,
 * so a canned fixture value would make those assertions vacuous.
 */
export function createPresignedPutUrlMock(): jest.Mock {
  return jest
    .fn()
    .mockImplementation((key: string, options?: CreatePresignedPutUrlOptions) =>
      Promise.resolve({
        url: `${SYNTHETIC_SIGNED_URL_ORIGIN}/put`,
        key,
        expiresAt: new Date(
          SYNTHETIC_SIGNING_EPOCH_MS + (options?.expiresInSeconds ?? 60) * 1000,
        ),
      }),
    );
}

/**
 * The keys this mock was asked to sign that belong to the CALLER's own
 * fixtures, identified by `marker` (a spec's per-run
 * `TEST_FIXTURE_NAMESPACE`-derived prefix).
 *
 * WHY THIS EXISTS. `expect(mock).not.toHaveBeenCalled()` is a GLOBAL
 * assertion: it silently asserts that no OTHER row anywhere in the shared
 * database needed signing either. That is not the invariant any of these
 * tests actually mean, and it broke the instant the four real curated
 * series gained covers (`Received number of calls: 4`). Asserting on the
 * suite-scoped subset states the real invariant — "nothing of MINE was
 * signed" — and is immune to unrelated rows and to parallel workers.
 */
export function signedKeysMatching(mock: jest.Mock, marker: string): string[] {
  return (mock.mock.calls as unknown[][])
    .map((call) => call[0])
    .filter((key): key is string => typeof key === 'string')
    .filter((key) => key.includes(marker));
}
