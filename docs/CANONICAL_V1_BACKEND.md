# Canonical Red Panda V1 Backend

**This repository is the single backend source-of-truth for Red Panda V1.**

| | |
|---|---|
| Worktree | `/Users/gladyaz/red-panda-backend` |
| Branch | `integration/red-panda-v1-final` |
| Established at | commit `fd3c86c` (2026-08-28) |
| Base | `fix/v1-provider-account-deletion` |
| Last consolidation | 2026-08-28 — admin media ingestion + VPS transcode worker (§1) |
| Deployment status | **Never deployed. No staging, no production.** |

Every other `short-drama-backend-*` worktree on this machine is a historical
feature worktree that has already been folded into this line. Continued V1
development, developer handover, staging, and eventual production promotion
all happen here.

> This document is an **index and an entry point**. It deliberately does not
> restate the runbooks it links to — each linked document remains the
> authority on its own subject.

---

## 1. Why this branch is canonical

`integration/red-panda-v1-final` is a strict descendant of every completed V1
backend line. Verified by `git merge-base --is-ancestor` against each branch
tip, not by reading commit messages:

| Line | Tip | In this branch |
|---|---|---|
| `feat/hls-transcoding-pipeline` | `f303308` | yes |
| `feat/production-https-readiness` | `0e3e8b9` | yes |
| `integration/playstore-v1-backend` | `f413083` | yes |
| `feat/v1-whatsapp-auth` | `a36cde5` | yes |
| `feat/v1-rewards-social` | `8f7bdf6` | yes |
| `integration/v1-auth-rewards` | `3a51e7a` | yes |
| `feat/v1-release-gate` | `01e8caa` | yes |
| `fix/v1-provider-account-deletion` | `fd3c86c` | yes (HEAD) |
| `feat/auth-production-identities` | `0fee0ee` | yes |
| `feat/auth-production-integration` | `a695a9c` | yes |
| `feat/guest-free-playback` | `7de8ba1` | yes |
| `feat/backend-hardening-final` | `3c72516` | yes |
| `feat/midtrans-payment-foundation` | `e9ee507` | yes |
| `master` | `2f285d1` | yes |

Reproduce the check:

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  git merge-base --is-ancestor "$b" HEAD && echo "OK   $b" || echo "MISS $b"
done
```

### Lines consolidated by cherry-pick

Two completed V1 lines were folded in on 2026-08-28 by `git cherry-pick -x`
rather than by merge, because each was a single cohesive commit sitting on the
same base (`fd3c86c`) as this branch, and the three touched **no file in
common**:

| Line | Source commit | Commit here | Files |
|---|---|---|---|
| `feat/admin-media-ingestion` | `9526b4f` | `e6559f3` | 10 |
| `feat/transcode-worker-deployment` | `344739f` | `7b812cc` | 34 |

**Read this before running the `--is-ancestor` loop above.** Because these were
cherry-picked, the two *branch tips* are **not** ancestors of HEAD and the loop
prints `MISS` for both. That is a statement about git topology, not about
content. All 44 files are byte-identical to their source commits, and each
commit here carries a `(cherry picked from commit …)` trailer. Verify content
rather than topology:

```bash
for c in 9526b4f 344739f; do
  for f in $(git show --name-only --format= $c); do
    [ "$(git rev-parse $c:"$f")" = "$(git rev-parse HEAD:"$f")" ] \
      || echo "DIFFERS $c $f"
  done
done
```

Both tips are now **stale** — the content is here. Do not merge them.

### Branches deliberately NOT in this line

Nine further commits are not reachable from HEAD — separately from the two
cherry-picked tips above, which ARE fully represented. None of these nine is
V1 backend scope, and none is lost work:

- **Superseded by reconciliation.** `feat/auth-lock-order-hardening`,
  `feat/auth-test-stability`, `feat/backend-test-infra-hardening`,
  `feat/password-reset-token-invalidation`, `feat/series-cover-concurrency`,
  `feat/series-cover-orphan-cleanup`, `feat/series-test-isolation`. Each is a
  single commit sitting 48–52 commits behind HEAD. All 32 files these
  branches introduced are present here (verified file-by-file against
  `HEAD:<path>`), landed through the hardening reconciliation commit
  `3c72516`. The two that added no new file —
  `feat/password-reset-token-invalidation` and `feat/series-cover-concurrency`
  — had their behaviour land too: reset-token invalidation is in
  `auth.service.ts`'s change-password transaction, and the cover
  compare-and-set is in `series.service.ts`. These branch tips are **stale**,
  not missing — do not merge them.
- **Out of backend scope.** `test/httprunner-api-regression` and
  `test/postman-api-qa` are external API QA tooling, not backend runtime code.

---

## 2. What V1 contains

| Subsystem | Where it lives | Contract / runbook |
|---|---|---|
| Auth core (email + password, sessions, audit, lockout) | `src/auth/` | [README](../README.md#auth-api-phase-8) |
| Google Login | `src/auth/identity/google/` | [auth-identity-api-contract.md](auth-identity-api-contract.md) |
| WhatsApp Login (Cloud API OTP) | `src/auth/identity/whatsapp/` | [WHATSAPP_LOGIN_SETUP.md](WHATSAPP_LOGIN_SETUP.md) |
| Provider-aware account deletion | `src/auth/deletion/`, `src/auth/account-deletion.controller.ts` | [ACCOUNT_DELETION.md](ACCOUNT_DELETION.md) |
| Rewards (wallet, ledger, check-in, redemption) | `src/rewards/` | [rewards-api-contract.md](rewards-api-contract.md) |
| Social missions | `src/rewards/social-missions.constants.ts` | [rewards-api-contract.md](rewards-api-contract.md) |
| Ad perks | `src/rewards/rewards-perks.service.ts`, `src/ads-config/` | [rewards-api-contract.md](rewards-api-contract.md) |
| HLS transcoding pipeline | `src/transcode/`, `src/transcode/hls/` | [HLS_TRANSCODE_WAVE.md](HLS_TRANSCODE_WAVE.md) |
| HLS demote / rollback | `src/transcode/demote/` | [HLS_TRANSCODE_WAVE.md](HLS_TRANSCODE_WAVE.md) |
| Playback authorization / HLS gateway tokens | `src/transcode/hls/hls-playback-token.util.ts`, `src/videos/` | [playback-api-contract.md](playback-api-contract.md) |
| R2 media storage + migration | `src/storage/`, `src/media/r2-migration/` | [R2_MEDIA_MIGRATION.md](R2_MEDIA_MIGRATION.md), [r2-readiness.md](r2-readiness.md) |
| Queue (BullMQ + out-of-process worker) | `src/transcode/bullmq-transcode-queue.client.ts`, `src/worker/` | [HLS_TRANSCODE_WAVE.md](HLS_TRANSCODE_WAVE.md) |
| Admin media ingestion (presigned direct-to-R2 PUT, HEAD-verified finalize) | `src/media/admin-media.controller.ts`, `src/media/admin-media.service.ts` | [admin-api-contract.md](admin-api-contract.md) |
| Admin processing status + transcode retry | `src/media/admin-media-status.ts`, `src/transcode/transcode-intent.service.ts` | [admin-api-contract.md](admin-api-contract.md) |
| Transcode worker VPS deployment package | `Dockerfile.worker`, `docker-compose.worker.yml`, `.dockerignore` | [TRANSCODE_WORKER_VPS.md](TRANSCODE_WORKER_VPS.md) |
| Production HTTPS hardening | `src/config/env.validation.ts` | [PRODUCTION_HTTPS.md](PRODUCTION_HTTPS.md) |
| Health / readiness | `src/health/` | `GET /health`, `/health/ready`, `/health/details` |
| `CONTENT_ACCESS_MODE=free` | `src/config/content-access-mode.util.ts` | [PLAY_STORE_V1_BACKEND.md](PLAY_STORE_V1_BACKEND.md#5-content_access_mode) |
| Production preflight | `src/common/production-preflight/` | [PRODUCTION_DEPLOYMENT_REQUIREMENTS.md](PRODUCTION_DEPLOYMENT_REQUIREMENTS.md) |
| Release gate | `src/common/release-gate/` | [V1_RELEASE_GATE.md](V1_RELEASE_GATE.md) |
| Staging procedure | — | [V1_STAGING_RUNBOOK.md](V1_STAGING_RUNBOOK.md) |
| Payments (Midtrans, **disabled in V1**) | `src/payments/` | [PLAY_STORE_V1_BACKEND.md](PLAY_STORE_V1_BACKEND.md#8-auth-and-monetisation) |

Two process entry points, deliberately separate so FFmpeg never runs inside an
HTTP request path:

- `src/main.ts` — the API (`AppModule`)
- `src/worker/main.ts` — the transcode worker (`WorkerModule`)
- `src/worker/health-main.ts` — the worker's one-shot health probe, used as the
  container `HEALTHCHECK` (`npm run worker:health`)

The worker ships a deployment package for an unattended VPS: `Dockerfile.worker`,
`.dockerignore`, `docker-compose.worker.yml`, configurable BullMQ concurrency
(`TRANSCODE_WORKER_CONCURRENCY`, default 1), a startup and periodic stale-temp
sweep, structured per-job logs, and a re-entrant graceful `SIGTERM`/`SIGINT`
shutdown that finishes in-flight work before exiting.

> **The image has never been built or run.** Docker is not installed on this
> machine, so `Dockerfile.worker` and `docker-compose.worker.yml` are reasoned
> and reviewed, not executed. That is the one unproven part of the media path.

> **Never start the worker against the default local Redis.**
> `redis://127.0.0.1:6379` db 0 currently holds **27 real waiting jobs** in
> `bull:media-transcode:wait`. Starting a worker there WILL transcode real
> catalog media. For any live worker experiment use an isolated database index
> you have verified empty (e.g. `redis://127.0.0.1:6379/15`).

---

## 3. Local setup

Requires **Node 22** (`engines: >=22.0.0 <25.0.0`), PostgreSQL, and Redis.

```bash
npm ci
npx prisma generate          # needs DATABASE_URL to merely EXIST
cp .env.example .env         # then fill it in
```

`.env` is gitignored and is never committed. The authoritative, secret-free
recipe for a working local configuration is
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — its `quality-gate`
job lists every variable the suite actually needs, with test-only literals.

Two databases are required and must be kept apart:

- `DATABASE_URL` — dev database; the `src/**/*.spec.ts` integration specs run
  against it directly.
- `DATABASE_URL_TEST` — dedicated e2e database. `test/jest-e2e.setup.ts`
  redirects `DATABASE_URL` to it for the duration of an e2e run and **throws
  if it is unset**, so e2e can never touch dev data.

Then:

```bash
npx prisma migrate deploy                       # dev database
DATABASE_URL="$DATABASE_URL_TEST" npx prisma migrate deploy   # test database
npm run db:seed
npm run media:fixtures       # placeholder bytes at every seeded storageKey
```

`npm run media:fixtures` never overwrites an existing file. Real company MP4s
are never committed.

---

## 4. Primary commands

| Command | What it does |
|---|---|
| `npm run start:dev` | API, watch mode |
| `npm run build` | Nest build — also the typecheck gate |
| `npm run lint:ci` | ESLint, verify only (no `--fix`) |
| `npm test` | Unit + `src/**` integration specs |
| `npm run test:e2e` | e2e suite against `DATABASE_URL_TEST` |
| `npm run release:gate` | **The pre-deployment gate** — see §5 |
| `npm run production:preflight` | Environment/config verdict |
| `npm run smoke:production` | Post-deploy proof a live origin serves bytes |
| `npm run media:r2-migrate` | R2 media migration (dry-run first) |
| `npm run hls:wave-enqueue` | Enqueue a transcode wave |
| `npm run hls:demote` | Demote a bad HLS generation (dry-run first) |
| `npm run worker:transcode` | Start the out-of-process transcode worker — **reads the queue** |
| `npm run worker:health` | One-shot worker health probe; the container `HEALTHCHECK` |
| `npm run retention` | Retention job (dry-run by default) |
| `npm run maintenance:series-cover-orphans` | Cover orphan cleanup (dry-run first) |

Every destructive utility above is **dry-run by default** and requires an
explicit flag to commit.

---

## 5. Release gate

```bash
npm run release:gate                      # CI / structural — the default
npm run release:gate -- --mode=local
npm run release:gate -- --mode=production
```

One deterministic, **read-only** command run before any staging or production
deploy. It never deploys, pushes, migrates, seeds, enqueues, writes to R2 or
Redis, or sends a message. It connects to a database only when one is named in
`RELEASE_GATE_DATABASE_URL`, and then only to read `prisma migrate status`.

It never fabricates a pass: a check that could not run reports **SKIPPED**,
with the reason. Exit `0` = no blockers, `1` = at least one blocker, `2` = the
gate itself could not run.

Full semantics, including why CI mode ignores the ambient environment:
[V1_RELEASE_GATE.md](V1_RELEASE_GATE.md).

The release timeline this sits in the middle of:

```
npm run release:gate   ->   deploy   ->   npm run smoke:production
judges code + config       the only      proves a live origin
offline                    step that     actually serves bytes
                           changes
                           anything
```

---

## 6. Staging

[V1_STAGING_RUNBOOK.md](V1_STAGING_RUNBOOK.md) is the authority: the full
environment inventory, the release configuration matrix, the external
dependency status, and the staging database procedure.

**Nothing here has been deployed.** V1 is engineering-ready but not
external-config-ready: Google, WhatsApp (Meta), the Rewards social profile
URLs, and AdMob all still need credentials or decisions that live outside this
repository. The default (CI/structural) gate grades a synthetic V1 posture and
says nothing about real credentials; it is `--mode=production`, run against a
real environment, that turns each missing one into a blocker. See the
runbook's §3 for exactly what is outstanding.

---

## 7. Verification baseline

Recorded on the consolidated HEAD (2026-08-28), Node 22, against a local
sandbox Postgres migrated to the full 24-migration history **and seeded**, with
local media fixtures generated. Reproduce with the commands in §4.

| Check | Result |
|---|---|
| `npx prisma validate` | schema valid (Prisma 6.19.3) |
| `npx prisma generate` | client generated |
| Migrations | 24, monotonic, provider `postgresql` — **unchanged by this consolidation** |
| `npm run build` | pass |
| `npm run lint:ci` | pass — 0 errors, 1 pre-existing warning |
| `npm test -- --runInBand` | **145 passed / 1 skipped** of 146 suites; **2762 passed / 7 skipped** of 2769 tests |
| `npm run test:e2e` | **33 passed** of 33 suites; **563 passed** of 563 tests |
| `npm run release:gate` | exit `0` — **0 blockers**, 34 pass, 1 warning, 2 skipped |
| `release:gate` migration status vs a real database | pass (read-only, via `RELEASE_GATE_DATABASE_URL`) |

Movement from the establishment baseline at `fd3c86c` (140 unit suites / 2644
tests; 32 e2e suites / 548 tests): **+6 unit suites, +125 unit tests, +1 e2e
suite, +15 e2e tests, 0 new blockers, 0 new failures.** The six new unit suites
are `admin-media-ingestion`, `admin-media-status`, `transcode-job-log`,
`transcode-temp`, `worker-health` and `worker-shutdown`; the new e2e suite is
`admin-media-ingestion.e2e-spec.ts`.

The one skipped unit suite is the Redis queue contract, which is opt-in by
design (`npm run test:redis-contract`). The one lint warning is an unused
`eslint-disable` directive in `src/media/r2-migration/run-r2-media-migration-cli.ts`.
The one gate warning is the compiled-in `http://localhost:3000` development
fallback in `src/config/configuration.ts`, which the gate reports every run by
design. The two gate SKIPs are the full DB-backed unit suite (opt-in via
`--with-db-tests`, because 53 of the unit suites talk to Postgres) and the
migration-status check (which refuses to guess a database and runs only when
`RELEASE_GATE_DATABASE_URL` is supplied explicitly — the row above records it
passing when it was).

### Running the unit suite in parallel

The gate's opt-in `--with-db-tests` step shells out to plain `npm test`, which
uses parallel Jest workers. On a contended machine the bcrypt-heavy auth specs
(register + login + delete in one test) can exceed Jest's default 5s timeout
and report a failure that is pure CPU contention — `account-deletion.service.spec.ts`
is the usual one. The same suite is green serially and green in isolation.
**Use `npm test -- --runInBand` as the authoritative unit run**, and treat an
isolated re-run as the tiebreaker.

### If the e2e suite fails on a shared sandbox database

A crashed or interrupted e2e run can leave fixture rows behind, and the next
run then fails with a `409 Conflict` on a fixture the previous run never
cleaned up. This is contamination, not a regression. The suites clean up after
themselves on a normal exit, so **re-run the suite** before investigating —
a second clean run is the real signal. Do not point two worktrees at the same
`DATABASE_URL_TEST` and run them concurrently.

---

## 8. Rules for this branch

- **Do not push without an explicit decision.** This line has never been
  pushed to a remote.
- **Do not merge the seven stale branches listed in §1.** Their content is
  already here.
- **Do not merge `feat/admin-media-ingestion` or `feat/transcode-worker-deployment`.**
  They were cherry-picked in; their tips are stale and merging them would
  replay work already present. Verify by content, not by `--is-ancestor` — see
  §1.
- Prisma migrations are append-only and must stay monotonic; the release gate
  checks migration/schema consistency.
- New work branches from `integration/red-panda-v1-final` and merges back into
  it.

---

## See also

- [DEVELOPER_HANDOVER.md](DEVELOPER_HANDOVER.md) — start here if you are new
- [README.md](../README.md) — API reference and architecture
- [PLAY_STORE_V1_BACKEND.md](PLAY_STORE_V1_BACKEND.md) — V1 scope and catalog state
- [PRODUCTION_DEPLOYMENT_REQUIREMENTS.md](PRODUCTION_DEPLOYMENT_REQUIREMENTS.md)
- [PRODUCTION_HTTPS.md](PRODUCTION_HTTPS.md)
- [admin-api-contract.md](admin-api-contract.md) — admin media ingestion, status and retry
- [TRANSCODE_WORKER_VPS.md](TRANSCODE_WORKER_VPS.md) — worker deployment runbook
