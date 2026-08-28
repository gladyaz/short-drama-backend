# Red Panda V1 — Developer Handover

**Audience:** a developer joining Red Panda V1 with no prior verbal context.

Read this end to end once (about 20 minutes). It is an **index and an
orientation**, not a replacement for the runbooks — each section links to the
document that remains the authority on its subject. Nothing here is restated
from those documents beyond what you need to know that they exist and when to
open them.

| | |
|---|---|
| Written | 2026-08-28 |
| Backend branch | `integration/red-panda-v1-final` |
| Deployment status | **Never deployed.** No staging, no production, no Play Store release. |
| Engineering status | V1 feature-complete and green on every local gate |
| Release status | Blocked on external credentials and infrastructure only — see §13 |

> The single most important thing to understand on day one: **V1 is
> engineering-ready but not release-ready, and every remaining blocker lives
> outside these repositories.** No blocker is a code defect, and none should be
> worked around in code.

---

## 1. Product V1 scope

Red Panda is a short-drama streaming app for the Indonesian market. Vertical
episodes, immersive feed, Bahasa Indonesia subtitles burned into the video.

**The whole catalog is free, funded by ads.** There is no payment, no
subscription, no coin purchase, and no premium paywall a viewer can reach.

| In V1 | Status |
|---|---|
| Free content for every viewer, including signed-out guests | shipped |
| Ads (AdMob interstitials, UMP consent gate) | shipped in the app; ad unit ids are external |
| Google Login | shipped; credentials external |
| WhatsApp Login (Meta Cloud API OTP) | shipped; credentials external |
| Rewards (daily check-in, watch milestones, social missions, coins, ad perks) | shipped; social profile URLs external |
| HLS adaptive playback | shipped; gateway Worker not deployed |
| Account deletion for every sign-in method | shipped |

| Deliberately NOT in V1 | Where it went |
|---|---|
| Payments (Midtrans) | code present, `PAYMENTS_ENABLED=false` |
| Subscriptions | never built |
| Premium paywall / entitlement UI | architecture intact, hidden behind `EXPO_PUBLIC_PREMIUM_EXPERIENCE_ENABLED=false` and `CONTENT_ACCESS_MODE=free` |
| Coin purchase | never built |

Premium is **switched off, not deleted.** The entitlement system, the premium
access tier, and the payment module all still exist and still work; V1 simply
configures them out of reach. See
[`PLAY_STORE_V1_BACKEND.md` §5](PLAY_STORE_V1_BACKEND.md) and, on the mobile
side, `red-panda-mobile/docs/v1-product-scope.md`.

---

## 2. Repository map

Four repositories. Three are canonical worktrees on this machine; the admin
dashboard lives elsewhere.

| Repo | Canonical path | Branch | Remote |
|---|---|---|---|
| **Backend** (API + transcode worker + HLS gateway Worker) | `/Users/gladyaz/red-panda-backend` | `integration/red-panda-v1-final` | `github.com/gladyaz/short-drama-backend` — **branch unpushed** |
| **Mobile** (Expo / React Native, Android + iOS) | `/Users/gladyaz/red-panda-mobile` | `integration/red-panda-v1-final` | `github.com/gladyaz/mobile-app-ecc` |
| **Website** (Next.js, public static site) | `/Users/gladyaz/red-panda-website` | `feat/public-website-v1` | **none configured** |
| **Admin dashboard** (Vite + React 19 operator console) | `/Users/gladyaz/coding-folder/short-drama-admin` | `feat/admin-effective-access-tier` | — |

**Work only in the canonical paths above.** Both the backend and the mobile
repo have many sibling worktrees on this machine holding historical feature
branches; all of their completed work has already been folded into the
canonical line. Restarting work in a sibling worktree loses it.

Which branches are stale, which were cherry-picked, and how to verify by
content rather than git topology: [`CANONICAL_V1_BACKEND.md` §1](CANONICAL_V1_BACKEND.md)
and `red-panda-mobile/docs/CANONICAL_V1_MOBILE.md`.

Two further backend worktrees exist — `red-panda-admin-media-backend` and
`red-panda-transcode-worker-deploy` — whose commits were **cherry-picked** into
the canonical branch. Their tips are stale. Do not merge them.

---

## 3. Architecture overview

```
   Android / iOS app  ─────HTTPS─────►  Red Panda API (NestJS, one process)
   (Expo, expo-video)                        │
          │                                  ├──► PostgreSQL (Prisma, 24 migrations)
          │                                  ├──► Redis / BullMQ  (queue handoff only)
          │                                  ├──► Cloudflare R2   (presigned GET/PUT)
          │                                  └──► mints HLS gateway tokens
          │                                              │
          └───playback────► HLS gateway ◄────────────────┘
                            (Cloudflare Worker,
                             workers/hls-gateway)
                                    │
                                    └──► R2 (private bucket)

   Admin dashboard ───HTTPS───► Red Panda API  (admin-guarded routes)
        (browser)  ───PUT──────► R2 directly, via a presigned URL the API minted

   VPS transcode worker (Docker) ──► Redis (consumes) ──► FFmpeg ──► R2 (writes HLS)

   Website (Next.js, static) — talks to nothing. No backend, no DB, no secrets.
```

**Component notes**

- **Mobile** — Expo / React Native, app id `com.spark.redpanda`. Immersive feed
  with runtime single-player ownership; HLS quality via variant-playlist source
  swap. Entry points under `src/app/`, services under `src/services/`.
- **Backend API** — NestJS, `src/main.ts` (`AppModule`). Listens
  `0.0.0.0:$PORT` in plain HTTP. **This process never speaks TLS**; HTTPS is
  always terminated in front of it. Topology and the four config values that
  become client-visible URLs: [`PRODUCTION_HTTPS.md` §1](PRODUCTION_HTTPS.md).
- **PostgreSQL** — Prisma, append-only migrations that must stay monotonic.
- **Redis / BullMQ** — used **only** for the transcode queue handoff. The API
  never runs FFmpeg. `TRANSCODE_ENABLED=false` is a valid V1 posture and needs
  no Redis at all.
- **R2** — the permanent object store: source media, HLS output, covers,
  thumbnails. The bucket is private; clients only ever receive short-lived
  presigned URLs or gateway-token URLs.
- **HLS gateway** — a Cloudflare Worker in `workers/hls-gateway/`. It serves
  playlists and segments out of the private bucket, gated by a short-TTL,
  prefix-scoped, HMAC-signed, **content-bound** token the API mints. The token
  carries no user claim, so the player needs no bearer header.
  **Never deployed; `wrangler.toml.example` is an unmodified template.**
- **VPS transcode worker** — a second process, `src/worker/main.ts`
  (`dist/worker/main`), deliberately separate so FFmpeg never runs inside an
  HTTP request path. Ships with `Dockerfile.worker`,
  `docker-compose.worker.yml`, configurable concurrency (default 1), stale-temp
  sweeps, and a graceful `SIGTERM` shutdown that finishes in-flight encodes.
  Runbook: [`TRANSCODE_WORKER_VPS.md`](TRANSCODE_WORKER_VPS.md).
  **The image has never been built** — Docker is not installed on this machine.
- **Website** — Next.js 16 App Router, four prerendered static pages
  (`/`, `/privacy`, `/delete-account`, `/support`) plus `app-ads.txt`,
  `robots.txt`, `sitemap.xml`. No database, no auth, no backend calls, no
  secrets. It exists to serve the surfaces Google Play requires.
- **Admin dashboard** — Vite + React 19 + TanStack Query, a **pure client** of
  the backend's admin API. Holds no database credential and no standing R2
  credential; it PUTs bytes to R2 only through a single-use presigned URL the
  backend minted for that one upload.

Route surface, in one place — API contracts:
[`admin-api-contract.md`](admin-api-contract.md),
[`auth-identity-api-contract.md`](auth-identity-api-contract.md),
[`playback-api-contract.md`](playback-api-contract.md),
[`rewards-api-contract.md`](rewards-api-contract.md). Health:
`GET /health`, `/health/ready`, `/health/details`.

---

## 4. Media workflow

The one path a real episode takes, from an operator's browser to a viewer's
phone:

```
 1. Admin Dashboard
      POST /admin/media                    → creates a `draft` row
                                             + a single-use presigned PUT URL

 2. Browser PUTs the file bytes DIRECTLY to R2 using that URL.
      The bytes never pass through the API. The dashboard never holds an
      R2 key or secret.

 3. POST /admin/media/:id/complete-upload  → finalize
      Server-side HEAD against R2 verifies the object exists, is non-empty,
      matches the recorded size, and sits at this row's own derived source key.
      Refuses otherwise. On success the row becomes `ready`.

 4. Enqueue
      Finalize places a transcode job on BullMQ (Redis). The durable state
      change commits first; the queue handoff is best-effort, and a lost
      handoff is recovered later by TranscodeReconcilerService — so a Redis
      outage never loses an upload.

 5. VPS FFmpeg worker  (`npm run worker:transcode`, concurrency 1)
      Consumes the job, transcodes a 360p/540p/720p ladder (1080p capped),
      packages master + per-rendition variant playlists + a poster thumbnail,
      and a package validator rejects truncated or cross-rendition playlists
      before anything is promoted.

 6. HLS output written to R2, row promoted to processingState = `ready`
      with an `hlsMasterKey`.

 7. Playback
      GET /videos/:id/playback runs the entitlement gate, then mints a
      gateway token and returns `masterUrl` + every rendition URL.
      The player fetches from the HLS gateway Worker, which reads R2.
```

**Operator visibility.** `GET /admin/media/:id/status` is a narrow,
poll-friendly payload (no R2 call, no presigned URL, no credential exposure),
and the same `processing` block is embedded on every admin media row so a list
view can badge every episode without one request per row.

**Retry.** `POST /admin/media/:id/retry-transcode` re-queues a **failed**
transcode against the source already in R2. It never asks for a re-upload and
returns no upload URL. A double-clicked Retry enqueues exactly once — the loser
of the compare-and-swap is refused with `MEDIA_TRANSCODE_NOT_RETRYABLE`.

**Storage precedence**, test-locked in `playback-source.util.spec.ts`:

```
HLS (processingState=ready + hlsMasterKey)
  └─► R2 (objectStorageKey)
        └─► local (storageKey, served by this process)
              └─► 409 MEDIA_PLAYBACK_SOURCE_UNAVAILABLE
```

A legacy `storageKey` is **inert** once `objectStorageKey` exists — "has a
storageKey" never means "depends on a developer's Mac".

Full runbooks: [`HLS_TRANSCODE_WAVE.md`](HLS_TRANSCODE_WAVE.md) (enqueue a
wave, observe, retry, demote), [`R2_MEDIA_MIGRATION.md`](R2_MEDIA_MIGRATION.md),
[`admin-api-contract.md`](admin-api-contract.md).

---

## 5. Auth

Three sign-in methods, one session model.

| Method | Where | Contract |
|---|---|---|
| Email + password | `src/auth/` | [`README.md`](../README.md) — "Auth API (Phase 8)" |
| Google Login | `src/auth/identity/google/` | [`auth-identity-api-contract.md`](auth-identity-api-contract.md) |
| WhatsApp OTP (Meta Cloud API) | `src/auth/identity/whatsapp/` | [`WHATSAPP_LOGIN_SETUP.md`](WHATSAPP_LOGIN_SETUP.md) |

Routes: `POST /auth/register|login|refresh|logout|logout-all`,
`GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`,
`POST /auth/google`, `POST /auth/whatsapp/otp/request|verify`,
`GET /auth/identities`, `POST /auth/identities/{google,whatsapp}/link`,
`DELETE /auth/identities/:provider`.

**WhatsApp OTP request always answers `202`** regardless of whether the number
is known — anti-enumeration. A `503` is carved out for a genuine provider
outage, because silently pretending to send would be worse. Read
[`auth-identity-api-contract.md` §1](auth-identity-api-contract.md) before
touching any of this; the security model is one sentence and the whole design
follows from it.

### Session storage on mobile — SecureStore only

`src/services/auth/session-secret-store.ts` is **the one module in the entire
mobile app allowed to import `expo-secure-store`.** Everything needing bearer
material at rest goes through `session-store.ts`, which goes through it.

On Android this puts the session behind the **Android Keystore**: AES-256-GCM
with a fresh IV per item, key held by the Keystore rather than by the process,
ciphertext in the app's private `SharedPreferences`. Legacy plaintext sessions
are migrated one-way on first launch.

`npm run release:preflight` **enforces the single-import rule** — a stray
`SecureStore.setItemAsync` anywhere else fails the check, because scattered
call sites would make "where do the tokens live" unanswerable.

### Account deletion by provider

> Deletion proof is appropriate to the identity, and is always a fresh
> re-demonstration of the same factor the account signs in with.

| Account has | Proof | Verified against |
|---|---|---|
| `passwordHash` | `password` | bcrypt against the stored hash |
| a `google` identity | `google` | a fresh Google ID token whose `sub` equals **this** account's `providerSubject` |
| a `whatsapp` identity | `whatsapp` | single-use OTP to **this** account's linked number, in the `account_deletion` namespace |

`GET /users/me/deletion/methods` tells the client which proofs the account
owns; **any one it owns suffices**, because each is already independently
sufficient to sign in and take full control.

There is **no unauthenticated web deletion API**, and V1 deliberately does not
add one — the reasoning (and why the WhatsApp half would be actively dangerous)
is in [`ACCOUNT_DELETION.md` §7](ACCOUNT_DELETION.md).

---

## 6. Rewards

Coins earned from three server-decided paths, spent on ad perks.

```
  daily check-in          ─┐
  social follow missions   ├─►  COINS  ─►  ad perks  ─►  fewer interruptions
  watch milestones        ─┘
```

| Earn | Key | Resets |
|---|---|---|
| Daily check-in | per reward day, `Asia/Jakarta` | daily |
| Watch milestones (`task_watch_3_episodes`, `task_watch_5_episodes`) | `WATCH_MILESTONE:<missionId>:<periodKey>` — counts **distinct** episodes started in one reward day | daily |
| Social follow missions (Instagram / TikTok / YouTube) | `EXTERNAL_SOCIAL_ACTION:<missionId>` — no period in the key | **never** — once per account, ever |

| Spend | Cost | Buys |
|---|---|---|
| `redeem_skip_next_ad` | 150 | one interstitial skip, valid 24h |
| `redeem_ad_pass_2h` | 600 | no interstitials for 2 hours |

Routes: `GET /rewards/snapshot|ledger|perks`, `POST /rewards/check-in`,
`POST /rewards/redemptions`, `POST /rewards/missions/:id/open|claim`,
`POST /rewards/perks/:id/consume`.

**Three things to internalize before changing anything here:**

1. **Social missions are `USER_CONFIRMED`, not verified.** The open→claim pair
   proves the server handed out the URL and the user said they followed. It
   proves **nothing about a follow**. Never rename it into something stronger.
2. **Watch credits are written from inside the playback path**, after the
   entitlement gate authorized the request — never from a request body. A
   `@@unique([userId, periodKey, videoId])` constraint is the anti-farming
   control: replaying the same episode all day yields exactly one credit.
   Recording a credit can never fail playback; the call swallows and logs its
   own errors.
3. **Perk liveness is derived from the clock, never read from `status`.** A
   2-hour pass stops working at `expiresAt` with no sweeper job involved.

VIP / premium-day redemptions still exist in the catalog but are **withheld**
under `CONTENT_ACCESS_MODE=free` (`COMING_SOON`,
`unavailableReason: NOT_APPLICABLE_IN_FREE_MODE`) and refused server-side —
selling "unlock premium" in a deployment where everything is already free is
selling nothing.

Authority: [`rewards-api-contract.md`](rewards-api-contract.md) (§6 is the
section to read if you read only one). Mobile side:
`red-panda-mobile/docs/rewards-domain-contract.md`.

---

## 7. Git workflow

### The target workflow

```
develop ──► feat/<name> or fix/<name> ──► PR ──► review ──► staging ──► main ──► production
```

- Branch from `develop`. One branch per change, `feat/` or `fix/`.
- Conventional commits: `<type>: <description>` — `feat`, `fix`, `refactor`,
  `docs`, `test`, `chore`, `perf`, `ci`.
- Open a PR; CI (`.github/workflows/ci.yml`) must be green before review.
- Review is mandatory for anything touching auth, playback authorization,
  rewards accounting, deletion, or migrations.
- Merge to `develop` → deploy to **staging** → promote to `main` →
  deploy to **production**.

### What is actually in place today, and the gap

This is important and a new developer will otherwise be confused by it:

- **There is no `develop` branch yet.** The canonical line is
  `integration/red-panda-v1-final`, and it has **never been pushed**. Today,
  new work branches from it and merges back into it
  ([`CANONICAL_V1_BACKEND.md` §8](CANONICAL_V1_BACKEND.md)).
- `master` exists and is 48+ commits behind. It is not the V1 line.
- The website repo has **no git remote at all**.
- **There is no staging and no production environment** to promote to.

Adopting the target workflow therefore means, in order: push the canonical
branch to `origin`; create `develop` from it; create `main` from it; configure
branch protection and required CI; then stand up staging. Until that happens,
follow the branch-from-canonical rule and open PRs against
`integration/red-panda-v1-final`.

### Non-negotiables

- Prisma migrations are **append-only** and must stay monotonic.
- Do not merge the stale branches enumerated in
  [`CANONICAL_V1_BACKEND.md` §1](CANONICAL_V1_BACKEND.md) — their content is
  already in the canonical line, and two of them were cherry-picked so
  `git merge-base --is-ancestor` reports a misleading `MISS`. Verify by
  **content**, not topology; the doc gives the exact loop.
- Never commit real company MP4s, `.env` files, keystores, or
  `wrangler.toml` with an `account_id` in it.

---

## 8. Local development setup

### Backend

Requires **Node 22** (`>=22.0.0 <25.0.0`), PostgreSQL, and Redis (Redis only if
you turn transcoding on).

```bash
cd /Users/gladyaz/red-panda-backend
npm ci
npx prisma generate          # needs DATABASE_URL to merely EXIST
cp .env.example .env         # then fill it in
```

**Two databases are required and must be kept apart:**

- `DATABASE_URL` — dev database. The `src/**/*.spec.ts` integration specs run
  against it directly.
- `DATABASE_URL_TEST` — a **dedicated** e2e database. `test/jest-e2e.setup.ts`
  redirects `DATABASE_URL` to it for the duration of an e2e run and **throws if
  it is unset**, so e2e can never touch dev data.

```bash
npx prisma migrate deploy                                      # dev DB
DATABASE_URL="$DATABASE_URL_TEST" npx prisma migrate deploy    # test DB
npm run db:seed
npm run media:fixtures        # placeholder bytes at every seeded storageKey
npm run start:dev
```

The authoritative, **secret-free** recipe for a working local configuration is
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — its `quality-gate`
job lists every variable the suite actually needs, with test-only literals.
Read it rather than guessing at `.env`.

`npm run media:fixtures` never overwrites an existing file, and real company
MP4s are never committed.

### Mobile

```bash
cd /Users/gladyaz/red-panda-mobile
npm ci                 # required in a fresh worktree
cp .env.example .env
npm start              # Expo dev server
```

Point `EXPO_PUBLIC_API_BASE_URL` at your machine's **LAN IP** (not
`localhost` — the handset cannot reach that), e.g. `http://192.168.1.x:3000`.
The backend must be running and reachable from the device's network.

Values that gate a real build: `EXPO_PUBLIC_API_BASE_URL`,
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, the two AdMob ids, and the three legal
URLs. See `red-panda-mobile/docs/CANONICAL_V1_MOBILE.md`.

### Website and admin dashboard

```bash
cd /Users/gladyaz/red-panda-website && npm ci && npm run dev   # 127.0.0.1:3000
```

```bash
cd /Users/gladyaz/coding-folder/short-drama-admin
npm install && cp .env.example .env   # point VITE_API_BASE_URL at your backend
npm run dev
```

The admin dashboard's test suite uses MSW and needs **no** running backend.
Connecting it to a real local backend requires a CORS origin — see its README.

---

## 9. Important validation commands

Run these before every commit, and always before opening a PR.

### Backend

```bash
npm run build              # Nest build — this is also the typecheck gate
npm run lint:ci            # ESLint, verify only (no --fix)
npm test -- --runInBand    # unit + src/** integration specs
npm run release:gate       # the pre-deployment gate
```

`npm run test:e2e` runs the e2e suite against `DATABASE_URL_TEST`.

**`npm run release:gate` is the one deterministic, read-only pre-deploy
command.** It never deploys, pushes, migrates, seeds, enqueues, or writes to R2
or Redis, and it never fabricates a pass — a check that could not run reports
**SKIPPED** with the reason. Exit `0` = no blockers, `1` = at least one
blocker, `2` = the gate itself could not run. Modes and semantics:
[`V1_RELEASE_GATE.md`](V1_RELEASE_GATE.md).

The release timeline it sits in the middle of:

```
npm run release:gate  ─►  deploy  ─►  npm run smoke:production
judges code + config      the only     proves a live origin
offline                   step that    actually serves bytes
                          changes
                          anything
```

Every destructive utility in `package.json` (`media:r2-migrate`,
`hls:wave-enqueue`, `hls:demote`, `retention`,
`maintenance:series-cover-orphans`) is **dry-run by default** and requires an
explicit flag to commit.

### Mobile

```bash
npm run lint
npm run typecheck
npm test -- --runInBand
npm run release:preflight
```

`release:preflight` enforces the V1 feature contract: Google, WhatsApp,
Rewards and HLS **required**; premium experience, any payment/subscription
dependency, mock or demo release configuration, Google's sample AdMob ids,
unsafe API base URLs, and secure-token-storage regressions all **blocked**.

### Verification baseline (2026-08-28, Node 22)

| Check | Backend | Mobile |
|---|---|---|
| build / typecheck | pass | clean |
| lint | pass (1 pre-existing warning) | clean |
| unit | 145 passed / 1 skipped of 146 suites; 2762 passed / 7 skipped of 2769 tests | 130 suites / 2147 tests passing |
| e2e | 33 of 33 suites, 563 of 563 tests | — |
| gate / preflight | `release:gate` exit `0` — **0 blockers**, 34 pass, 1 warning, 2 skipped | `release:preflight` exit `1` — **7 external blockers**, 2 warnings |

Reproduce and interpret: [`CANONICAL_V1_BACKEND.md` §7](CANONICAL_V1_BACKEND.md).

---

## 10. Environment boundaries

Three environments. **Staging is not a smaller production; it is a separate
one** — separate database, separate bucket, separate auth secrets.

| Setting | LOCAL DEV | STAGING | PRODUCTION |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` |
| `PUBLIC_BASE_URL` | `http://<LAN-IP>:3000` | https, real staging host | https, real production host |
| `STORAGE_DRIVER` | `local` or `r2` | `r2` | `r2` |
| `OBJECT_STORAGE_*` | local MinIO or dev bucket | **separate staging bucket** | production bucket |
| `TRANSCODE_ENABLED` | `false` | `false` for first deploy | `false` until gateway + worker are proven |
| `GOOGLE_AUTH_ENABLED` | `false` or `true` | `true` | `true` |
| `WHATSAPP_OTP_PROVIDER_DRIVER` | `fake` | `cloud-api` | `cloud-api` |
| `CONTENT_ACCESS_MODE` | `free` | `free` | `free` |
| `PAYMENTS_ENABLED` | `false` | `false` | `false` |
| `DEV_TOOLS_ENABLED` | `true` | **`false`** | **`false`** |
| `DATABASE_URL_TEST` | set | **unset** | **unset** |

The full inventory — every variable, whether it is required, and what it does —
is [`V1_STAGING_RUNBOOK.md` §1–§2](V1_STAGING_RUNBOOK.md). Production
specifics: [`PRODUCTION_DEPLOYMENT_REQUIREMENTS.md`](PRODUCTION_DEPLOYMENT_REQUIREMENTS.md)
and [`PRODUCTION_HTTPS.md`](PRODUCTION_HTTPS.md).

**Four settings are structurally impossible to inherit from local** — the boot
itself refuses them: `DEV_TOOLS_ENABLED=true` outside development/test,
`WHATSAPP_OTP_PROVIDER_DRIVER=fake` outside development/test, a cleartext or
LAN `PUBLIC_BASE_URL` under production, and `MIDTRANS_IS_PRODUCTION=true`
outside production. Two more are caught by the preflight: `DATABASE_URL_TEST`
being set, and a `PUBLIC_BASE_URL` on a reserved or placeholder domain.

**No secret appears in this document, and none belongs in any repository.**
`.env` is gitignored everywhere. On the website, no secret may ever go in a
`NEXT_PUBLIC_*` variable — those are inlined at build time and permanently
public.

---

## 11. Invariants — do not break these

Each of these exists because breaking it caused, or would cause, a real
failure. None is stylistic.

1. **The VPS is compute; R2 is permanent storage.** The worker's local disk is
   scratch. Anything that must survive a container restart goes to R2.
2. **Never send large media through the API when a direct R2 upload is
   available.** The admin dashboard PUTs bytes straight to R2 with a
   single-use presigned URL. Routing episode bytes through the API would put a
   multi-hundred-megabyte body in an HTTP request path that has a body-size
   limit and a request timeout.
3. **Never persist bearer tokens in AsyncStorage.** `session-secret-store.ts`
   is the only module allowed to touch `expo-secure-store`, and
   `release:preflight` enforces that. This is a regression the app already had
   once.
4. **Google Login, WhatsApp Login, Rewards and HLS are required V1 features.**
   The mobile preflight fails if any is disabled or unreachable. Do not "temporarily"
   switch one off to unblock a build.
5. **Payment and premium stay off.** `PAYMENTS_ENABLED=false`,
   `CONTENT_ACCESS_MODE=free`, `EXPO_PUBLIC_PREMIUM_EXPERIENCE_ENABLED=false`.
   `CONTENT_ACCESS_MODE=free` **outranks per-row premium overrides** — rows
   carrying an explicit `premium` tier still play free in this mode.
6. **Auto quality plays the master playlist; manual quality plays that
   rendition's own variant URL.** They are different playlists, not different
   labels — `expo-video` exposes `videoTrack` as read-only, so a source swap is
   the only truthful mechanism. Manual state stores a rendition **name**
   (`'720p'`), never a URL, because a variant URL carries a token that dies at
   `expiresAt`.
7. **The deletion OTP is not the login OTP.** Deletion challenges live in the
   `account_deletion` namespace. Never let one satisfy the other.
8. **Never start the transcode worker against the default local Redis.**
   `redis://127.0.0.1:6379` db `0` holds **27 real waiting jobs** in
   `bull:media-transcode:wait`. Starting a worker there **will** transcode real
   catalog media. For any live worker experiment, use an isolated database
   index you have verified empty, e.g. `redis://127.0.0.1:6379/15`.
9. **`HLS_TOKEN_SECRET` must be byte-identical to the gateway Worker's secret
   and distinct from all three auth secrets.** The boot refuses a collision.
10. **The API never transcodes**, and the two process entry points
    (`src/main.ts`, `src/worker/main.ts`) stay separate for exactly that
    reason.

---

## 12. Common troubleshooting

**Tests fail with missing tables, or e2e throws at startup.**
The database was never migrated or seeded, or `DATABASE_URL_TEST` is unset.
Run the §8 sequence for **both** databases. `test/jest-e2e.setup.ts` throws
deliberately when `DATABASE_URL_TEST` is missing rather than silently using
the dev database.

**Playback 404s locally, or the feed shows videos that will not play.**
Media fixtures were never generated. `npm run media:fixtures` writes
placeholder bytes at every seeded `storageKey`; it never overwrites an existing
file. Real company MP4s are never committed, so a fresh clone has no playable
bytes until you run it.

**Redis queue safety.** See invariant 8 — the default local Redis db 0 holds
27 real queued jobs. Inspect a queue before pointing a worker at it. The
Redis queue contract suite is opt-in by design:
`npm run test:redis-contract`.

**`release:preflight` fails on mobile.** Expected. All 7 failures are missing
credentials and unpublished pages (§13), not code defects. Do not work around
them in code — that is precisely what the preflight exists to prevent.

**Test environment caveats:**

- **`npm test -- --runInBand` is the authoritative unit run.** The gate's
  opt-in `--with-db-tests` step shells out to plain `npm test`, which uses
  parallel Jest workers; on a contended machine the bcrypt-heavy auth specs
  (`account-deletion.service.spec.ts` is the usual one) can exceed Jest's
  default 5s timeout and report pure CPU contention as a failure. The same
  suite is green serially and green in isolation.
- **53 of the unit suites talk to Postgres.** That is why the DB-backed suite
  is an opt-in gate step rather than a default.
- **A `409 Conflict` on the first e2e run after a crash is contamination, not
  a regression.** The suites clean up on a normal exit; a crashed run leaves
  fixture rows behind. **Re-run the suite** — a second clean run is the real
  signal. Never point two worktrees at the same `DATABASE_URL_TEST`
  concurrently.
- A handful of e2e failures on this specific machine have historically traced
  to its local `.env`, not to the code. Diff against a known-good commit before
  investigating a regression.

**Something looks wrong in the media pipeline.**
Read [`HLS_TRANSCODE_WAVE.md`](HLS_TRANSCODE_WAVE.md) §6 (detecting failure)
and §7 (retrying safely) before touching anything. `npm run hls:demote`
reverses a bad live generation, dry-run first — but note there is **no
generation history**, so a demote is not a true rollback, and already-minted
tokens survive a demotion for up to an hour.

---

## 13. Current external blockers

**Everything below is outside these repositories.** None is a code defect.
None should be worked around in code.

### Engineering-ready — proven here, nothing outstanding

- Backend: build, lint, 146 unit suites, 33 e2e suites, `release:gate` at
  **0 blockers**.
- Mobile: lint, typecheck, 130 suites / 2147 tests, and a static
  backend-contract regression lock (`src/services/contract/`) that fails a test
  here if the auth / rewards / HLS / deletion wire shapes drift.
- Website: four static pages build and pass their hygiene tests.
- Admin dashboard: real draft-create → direct-to-R2 upload → verified finalize
  → publish, end to end.

### Externally unverified — blocking release

| # | Blocker | Owner action | Status |
|---|---|---|---|
| 1 | **Google OAuth** — no client ids exist | Create the OAuth client(s); set `GOOGLE_OAUTH_CLIENT_IDS` (backend) and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (mobile) | **Not started.** No Google credential has ever been exercised by this code. A blocker in both the backend gate and the mobile preflight. |
| 2 | **WhatsApp (Meta)** — no sender number, token or template | Business verification, sender number, permanent access token, approved authentication template | **Not started.** [`WHATSAPP_LOGIN_SETUP.md`](WHATSAPP_LOGIN_SETUP.md) is the step-by-step. **No real OTP has ever been delivered end to end** — one live send to a handset you control is still owed. |
| 3 | **AdMob** — app id is still Google's public sample id | Create the AdMob app + interstitial unit; publish `app-ads.txt` on the domain | **Not supplied.** Entirely mobile-side. |
| 4 | **Domain** — none chosen or registered | Register; point DNS; issue TLS | **Not chosen.** Blocks the website, `app-ads.txt` verification, the API origin, and the HLS gateway origin. See `red-panda-website/docs/DOMAIN_CHECKLIST.md`. |
| 5 | **Staging / production infrastructure** — none exists | Provision host, Postgres, R2 bucket, TLS terminator; then the VPS worker and the Cloudflare Worker | **Nothing deployed, ever.** The HLS gateway Worker has never been deployed (`wrangler.toml.example` is an unmodified template) and `Dockerfile.worker` has never been built — Docker is not installed on this machine. |
| 6 | **Play signing** — no upload keystore | Create the keystore; add `keystore.properties` (gitignored) | **Not configured.** A build today would be debug-signed. |
| 7 | **Physical-device QA** — never run on real hardware | Run the device matrix | **Not done.** Playback, quality switching, OTP delivery, ads and consent all need a real handset. |

Also outstanding, smaller: `REWARDS_SOCIAL_*_URL` real Red Panda profile URLs
(social missions currently point nowhere), `EXPO_PUBLIC_PRIVACY_POLICY_URL`,
`EXPO_PUBLIC_ACCOUNT_DELETION_URL` and `EXPO_PUBLIC_TERMS_URL` (the pages exist
in the website repo but are not published anywhere).

Owner-side, step-by-step: `red-panda-mobile/docs/play-store-v1-owner-checklist.md`.
Backend external dependency detail: [`V1_STAGING_RUNBOOK.md` §3](V1_STAGING_RUNBOOK.md).

### Known documentation drift

Two known-stale spots, recorded so you do not trust them:

1. **`red-panda-website/src/app/delete-account/page.tsx`** still leads with a
   section saying Google and WhatsApp accounts *cannot* delete in-app and must
   email support. **That is no longer true** — every V1 sign-in method now has
   a real in-app deletion path. The required rewrite is spelled out in
   [`ACCOUNT_DELETION.md` §7](ACCOUNT_DELETION.md). This page must be corrected
   before it is published, because Google Play will read it.
2. **[`admin-api-contract.md`](admin-api-contract.md)**'s closing
   *"Explicitly still GATED"* section predates the 2026-08-28 ingestion
   re-freeze at the top of the same file. It says real R2 presigned byte
   uploads are gated and that `/videos/:id/stream` still serves only from local
   `STORAGE_ROOT`. Both statements are stale: direct-to-R2 upload is real end
   to end, and storage precedence is HLS → R2 → local. The **route contracts**
   in that document are accurate; only that trailing gating list is out of
   date.

---

## 14. First-day checklist

Work down this list. Everything in it is read-only or local — nothing here
deploys, pushes, or touches shared infrastructure.

**Read (about an hour)**

- [ ] This document, end to end.
- [ ] [`CANONICAL_V1_BACKEND.md`](CANONICAL_V1_BACKEND.md) — which branch is
      real and why.
- [ ] `red-panda-mobile/docs/CANONICAL_V1_MOBILE.md` — the same, for mobile.
- [ ] [`playback-api-contract.md`](playback-api-contract.md) §1 (the
      authorization matrix) — the single densest page in the system.
- [ ] [`rewards-api-contract.md`](rewards-api-contract.md) §6 — what the
      evidence actually is.

**Run (backend)**

- [ ] `npm ci && npx prisma generate`
- [ ] Configure `.env` from `.github/workflows/ci.yml`'s `quality-gate` job.
- [ ] Migrate **both** databases, `npm run db:seed`, `npm run media:fixtures`.
- [ ] `npm run build && npm run lint:ci`
- [ ] `npm test -- --runInBand` → expect 145 passed / 1 skipped of 146 suites.
- [ ] `npm run test:e2e` → expect 33 of 33.
- [ ] `npm run release:gate` → expect exit `0`, 0 blockers.
- [ ] `npm run start:dev`, then `curl localhost:3000/health/details`.

**Run (mobile)**

- [ ] `npm ci && cp .env.example .env`, set `EXPO_PUBLIC_API_BASE_URL` to your
      LAN IP.
- [ ] `npm run lint && npm run typecheck && npm test -- --runInBand`
- [ ] `npm run release:preflight` → expect exit `1` with exactly the **7**
      external blockers in §13. If you see an 8th, that one is yours.
- [ ] `npm start`, open the app, and play an episode against your local
      backend.

**Optional, if you will touch those surfaces**

- [ ] Website: `npm ci && npm test && npm run build`.
- [ ] Admin dashboard: `npm install && npm test` (MSW-mocked, no backend
      needed).

**Confirm you understand, before your first PR**

- [ ] Which branch is canonical, and that it has never been pushed (§2, §7).
- [ ] That the VPS is compute and R2 is permanent storage (§11.1).
- [ ] That bearer tokens live only in SecureStore (§11.3).
- [ ] That the default local Redis holds 27 real jobs (§11.8).
- [ ] That every remaining release blocker is external (§13).

---

## See also

Backend documents, all in this directory:

- [`CANONICAL_V1_BACKEND.md`](CANONICAL_V1_BACKEND.md) — branch provenance, setup, verification baseline
- [`PLAY_STORE_V1_BACKEND.md`](PLAY_STORE_V1_BACKEND.md) — V1 scope and real catalog state
- [`V1_RELEASE_GATE.md`](V1_RELEASE_GATE.md) — the pre-deploy gate
- [`V1_STAGING_RUNBOOK.md`](V1_STAGING_RUNBOOK.md) — environment inventory, staging procedure
- [`PRODUCTION_DEPLOYMENT_REQUIREMENTS.md`](PRODUCTION_DEPLOYMENT_REQUIREMENTS.md) · [`PRODUCTION_HTTPS.md`](PRODUCTION_HTTPS.md)
- [`TRANSCODE_WORKER_VPS.md`](TRANSCODE_WORKER_VPS.md) · [`HLS_TRANSCODE_WAVE.md`](HLS_TRANSCODE_WAVE.md)
- [`R2_MEDIA_MIGRATION.md`](R2_MEDIA_MIGRATION.md) · [`r2-readiness.md`](r2-readiness.md)
- [`ACCOUNT_DELETION.md`](ACCOUNT_DELETION.md) · [`WHATSAPP_LOGIN_SETUP.md`](WHATSAPP_LOGIN_SETUP.md)
- [`admin-api-contract.md`](admin-api-contract.md) · [`auth-identity-api-contract.md`](auth-identity-api-contract.md) · [`playback-api-contract.md`](playback-api-contract.md) · [`rewards-api-contract.md`](rewards-api-contract.md)
- [`series-cover-orphan-cleanup.md`](series-cover-orphan-cleanup.md)
- [`../README.md`](../README.md) — full API reference

Other repositories (paths, not links — these are separate checkouts):

- `red-panda-mobile/docs/` — `CANONICAL_V1_MOBILE.md`, `v1-product-scope.md`,
  `playback-quality.md`, `rewards-domain-contract.md`, `v1-contract-lock.md`,
  `release-readiness-android.md`, `play-store-v1-owner-checklist.md`,
  `api-contract.md`, `internal-storage.md`
- `red-panda-website/docs/` — `DEPLOYMENT.md`, `DOMAIN_CHECKLIST.md`,
  `ADMOB_APP_ADS_SETUP.md`, `PRIVACY_FACT_INVENTORY.md`
- `coding-folder/short-drama-admin/README.md`
