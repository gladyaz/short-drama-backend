# R2 Readiness Runbook

**Phase 11, work unit 11G-4.** This is an operational runbook for the
`STORAGE_DRIVER` flag (11G-3) and the storage-readiness health signal
(11G-4). It documents rollback, the (not-yet-performed) credential-insertion
procedure, and the disposable-object smoke test's cleanup plan.

**No real credentials, endpoints, bucket names, or account IDs appear in
this document.** Every value below is a placeholder (`<...>` or an obvious
`changeme-*` string). Do not paste real values into this file, and do not
commit real values anywhere in this repository — real credentials live only
in each operator's local, uncommitted `.env`.

## 1. What `/health/details` tells you

`GET /health/details` (dev-gated behind `DevToolsGuard`,
`DEV_TOOLS_ENABLED=true`) includes a `storage` section:

```json
{
  "storage": {
    "driver": "local",
    "ready": true,
    "configPresent": true
  }
}
```

In `r2` mode it carries one extra field:

```json
{
  "storage": {
    "driver": "r2",
    "ready": true,
    "configPresent": true,
    "publicDeliveryAvailable": false
  }
}
```

- `driver` — the active `STORAGE_DRIVER` (`"local"` or `"r2"`). Not a secret.
- `configPresent` — are the required config variable **names** for the
  active driver all set? (`local` → `STORAGE_ROOT`; `r2` → every name in
  `env.validation.ts`'s `REQUIRED_R2_KEYS`, imported from that one canonical
  list, never restated here or in the service.) Presence only — never a
  value.
- `ready` —
  - `local`: `STORAGE_ROOT` exists and is a readable directory (a local
    `fs.stat`, never a network call).
  - `r2`: always equal to `configPresent`. **This endpoint deliberately
    never makes a live network/R2 probe** — `ready: true` in `r2` mode means
    "the required config names are set", not "R2 was successfully
    contacted". Verifying real connectivity is what the disposable-object
    smoke test (section 3) and the one-test-file step (section 2) are for.
- `publicDeliveryAvailable` (**`r2` mode only**, added by Phase 11, work
  unit 11I-B1) — is `OBJECT_STORAGE_PUBLIC_BASE_URL` configured, i.e. can
  this deployment hand out **public** (non-presigned) object URLs? Presence
  only, never the URL. **It does not affect `ready` or `configPresent`**: a
  private bucket serves media through presigned PUT/GET only and is fully
  ready with `publicDeliveryAvailable: false`. Omitted entirely under
  `local`, where public object-storage delivery does not apply.

The response never includes the endpoint URL, bucket name, region, access
key, secret, or any absolute filesystem path.

## 2. Credential-insertion steps (documented here, NOT performed by this work unit)

This is the procedure a human operator follows when Phase 11's R2 cutover is
actually approved and executed. Nothing in work unit 11G-4 performs any of
these steps — no bucket was created, no credential was requested or typed,
and no network call was made against R2 in this unit's implementation.

1. **Obtain a bucket + token** (human, outside this repo): create (or reuse)
   the target Cloudflare R2 bucket and an R2 API token scoped to that bucket
   only (read+write, not account-wide).
2. **Put the real values in `.env`** (never `.env.example`, never
   committed). The five uncommented names below are the required ones
   (`env.validation.ts`'s `REQUIRED_R2_KEYS`);
   `OBJECT_STORAGE_PUBLIC_BASE_URL` is **optional** and is correctly left
   unset/empty for a private bucket:
   ```
   OBJECT_STORAGE_ENDPOINT=https://<YOUR_ACCOUNT_ID>.r2.cloudflarestorage.com
   OBJECT_STORAGE_REGION=auto
   OBJECT_STORAGE_BUCKET=<YOUR_BUCKET>
   OBJECT_STORAGE_ACCESS_KEY_ID=<YOUR_ACCESS_KEY_ID>
   OBJECT_STORAGE_SECRET_ACCESS_KEY=<YOUR_SECRET_ACCESS_KEY>
   # OPTIONAL — set ONLY if the bucket genuinely has public delivery
   # (r2.dev or a custom domain). Private bucket → leave this out entirely.
   # OBJECT_STORAGE_PUBLIC_BASE_URL=<YOUR_PUBLIC_CDN_BASE_URL>
   ```
   **Never invent a placeholder value for it to "satisfy" boot** — boot
   does not want it, and any non-empty value makes
   `publicDeliveryAvailable` (section 1) falsely report `true` for a
   deployment that has no public delivery at all.
3. **Set `STORAGE_DRIVER=r2`** in `.env` and restart the app. Boot fails
   fast (secret-free error message, variable name only) if any of the
   **five** names in `env.validation.ts`'s `REQUIRED_R2_KEYS` is missing.
   `OBJECT_STORAGE_PUBLIC_BASE_URL` is not one of them and never blocks
   boot.
4. **Check the readiness endpoint**: `GET /health/details` (dev tools
   enabled) → confirm `storage.driver === "r2"` and
   `storage.configPresent === true`. Remember `ready` here reflects config
   presence only, not a live probe.
5. **Upload ONE test file** through the existing presigned-upload flow (a
   throwaway/test media asset, not a real company video) and confirm the
   object lands in the bucket.
6. **Verify playback** end-to-end through the mobile/admin client against
   that one test file.
7. **Clean up the test file** — delete the test object from the bucket
   (same disposable-key discipline as section 3 below) once verified.
8. **Run the real migration** as a separate, explicitly human-gated step
   (out of scope for this unit) — this is where any existing local-storage
   media would actually be copied to R2. Not performed, planned, or
   scheduled by this document.

At every step, `STORAGE_DRIVER=local` remains the safe default and nothing
above changes local-mode behavior.

## 3. Disposable-object smoke test — cleanup plan

`src/storage/storage-r2-smoke.spec.ts` contains ONE opt-in Jest test that
performs a real `PutObject` → `HeadObject` → `DeleteObject` round-trip
against an **already-existing** bucket. It never creates a bucket.

**Gating (both required, AND'd together):**
- `RUN_R2_SMOKE=1` set explicitly in the environment (never on by default,
  never in CI).
- Every `OBJECT_STORAGE_*` variable name in `env.validation.ts`'s
  `REQUIRED_R2_KEYS` present in the environment.

If either is missing — the default state, and the state of this
credential-free session — the entire suite is skipped via `describe.skip`
and **zero network calls are made**: the gate check only reads
`process.env`, it never constructs an `S3Client`.

**Object key naming:** `_r2-smoke-tests/11g-4-<epoch-ms>-<uuid>.txt` — the
`_r2-smoke-tests/` prefix makes it trivially identifiable as disposable
test debris (never a real media key shape), and the epoch-ms + UUID suffix
guarantees uniqueness across runs so parallel/repeated runs never collide.

**Deletion:** the test's own `afterAll` issues a `DeleteObjectCommand` for
that exact key, wrapped so it always runs even if the `it` body throws
partway through the round-trip (a failed `PutObject`/`HeadObject` assertion
still triggers the best-effort cleanup). The `it` body itself also asserts,
after its own `DeleteObjectCommand`, that a follow-up `HeadObject` for the
same key rejects (object confirmed gone) before the test completes.

**Verifying no residue, if ever run for real:** list objects under the
`_r2-smoke-tests/` prefix in the bucket (e.g. via the R2 dashboard, or
`aws s3 ls s3://<YOUR_BUCKET>/_r2-smoke-tests/ --endpoint-url <...>` with the
same credentials) — it should be empty. If a stale object is ever found
(e.g. a process was killed mid-test, before `afterAll` ran), delete it
manually; its `_r2-smoke-tests/11g-4-...` name makes it unambiguous that it
is safe to remove and never a real media asset.

## 4. Rollback (r2 → local)

If anything looks wrong after switching to `r2` (including partway through
section 2's steps):

1. Set `STORAGE_DRIVER=local` in `.env` (or unset it entirely — `local` is
   the default).
2. Restart the app.
3. Confirm `GET /health/details` → `storage.driver === "local"` and
   `storage.ready === true` (assuming `STORAGE_ROOT` is a valid, readable
   directory, which it already must be for the app to have booted at all —
   see `env.validation.ts`).

This is fully reversible: no data is deleted, no migration is triggered, and
nothing about local-mode `StorageService` behavior changes as a side effect
of having briefly set `STORAGE_DRIVER=r2`.
