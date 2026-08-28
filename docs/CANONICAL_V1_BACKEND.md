# Canonical Red Panda V1 Backend

**This repository is the single backend source-of-truth for Red Panda V1.**

| | |
|---|---|
| Worktree | `/Users/gladyaz/red-panda-backend` |
| Branch | `integration/red-panda-v1-final` |
| Established at | commit `fd3c86c` (2026-08-28) |
| Base | `fix/v1-provider-account-deletion` |
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

### Branches deliberately NOT in this line

Nine commits in the repository are not reachable from HEAD. None of them is
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

## 7. Verification baseline at establishment

Recorded when this branch was made canonical, on commit `fd3c86c`, Node 22,
against a local sandbox Postgres already migrated to the full 24-migration
history. Reproduce with the commands in §4.

| Check | Result |
|---|---|
| `npx prisma validate` | schema valid (Prisma 6.19.3) |
| `npx prisma generate` | client generated |
| Migrations | 24, monotonic, provider `postgresql` |
| `npm run build` | pass |
| `npm run lint:ci` | pass — 0 errors, 1 pre-existing warning |
| `npm test -- --runInBand` | **139 passed / 1 skipped** of 140 suites; **2637 passed / 7 skipped** of 2644 tests |
| `npm run test:e2e` | **32 passed** of 32 suites; **548 passed** of 548 tests |
| `npm run release:gate` | **0 blockers**, 34 checks pass, 1 warning |
| `release:gate` migration status vs a real database | pass (read-only, via `RELEASE_GATE_DATABASE_URL`) |

The one skipped unit suite is the Redis queue contract, which is opt-in by
design (`npm run test:redis-contract`). The one lint warning is an unused
`eslint-disable` directive in `src/media/r2-migration/run-r2-media-migration-cli.ts`.
The one gate warning is the compiled-in `http://localhost:3000` development
fallback in `src/config/configuration.ts`, which the gate reports every run by
design.

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
- Prisma migrations are append-only and must stay monotonic; the release gate
  checks migration/schema consistency.
- New work branches from `integration/red-panda-v1-final` and merges back into
  it.

---

## See also

- [README.md](../README.md) — API reference and architecture
- [PLAY_STORE_V1_BACKEND.md](PLAY_STORE_V1_BACKEND.md) — V1 scope and catalog state
- [PRODUCTION_DEPLOYMENT_REQUIREMENTS.md](PRODUCTION_DEPLOYMENT_REQUIREMENTS.md)
- [PRODUCTION_HTTPS.md](PRODUCTION_HTTPS.md)
