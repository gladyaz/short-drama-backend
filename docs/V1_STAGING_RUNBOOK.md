# Red Panda V1 — Staging Runbook

**No staging environment exists yet.** No host, no database, no bucket, no
DNS name and no TLS certificate has been provisioned for one, and nothing in
this repository has ever connected to one. This document is the procedure for
the first staging deployment, written before it happens — it is a work list,
not a record of completed work.

Everything below was derived from the code on `integration/v1-auth-rewards`
(`src/config/env.validation.ts`, `src/config/configuration.ts`,
`src/common/production-preflight/preflight.ts`, `prisma/migrations/`, the
controllers), not from `.env.example`. Where the two disagree, the code wins
and this document says so.

**Companion documents.** This one covers the staging *procedure*. It does not
restate what these already cover:

| Topic | Document |
|---|---|
| HTTPS topology, CORS, proxy rules, health contract | `docs/PRODUCTION_HTTPS.md` |
| Runtime, resources, platform requirements | `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` |
| What V1 is, and what is out of scope | `docs/PLAY_STORE_V1_BACKEND.md` |
| Obtaining Meta WhatsApp credentials | `docs/WHATSAPP_LOGIN_SETUP.md` |
| Rewards wire contract, honesty limits | `docs/rewards-api-contract.md` |
| Auth/identity wire contract, Google client ids | `docs/auth-identity-api-contract.md` |
| Moving media into R2 | `docs/R2_MEDIA_MIGRATION.md` |
| The one read-only command that grades a release before it ships | `docs/V1_RELEASE_GATE.md` |

---

## 1. Environment inventory

Classification is derived from the validators, not from the template. Five
classes:

- **REQUIRED PRODUCTION** — boot fails without it in any environment.
- **REQUIRED WHEN FEATURE ENABLED** — boot fails only when its flag is on.
- **OPTIONAL** — has a documented default; if present it must be well-formed.
- **DEVELOPMENT ONLY** — safe locally, refused or dangerous in production.
- **TEST ONLY** — belongs to the test/maintenance surface, never to a service.

No value below is a secret and none is printed by any tool in this repo: every
validator and the preflight name variables only. The few that deliberately
*do* echo their value are public by nature — URLs, hostnames and flags.

### CORE

| Variable | Class | Notes |
|---|---|---|
| `NODE_ENV` | REQUIRED PRODUCTION | Must be exactly `production`. Every production guard keys on that string; a typo silently disables all of them. The preflight blocks anything else. |
| `PORT` | REQUIRED PRODUCTION | In `REQUIRED_KEYS`. Managed platforms inject it. |
| `PUBLIC_BASE_URL` | REQUIRED PRODUCTION | Must be an absolute **https** URL, not loopback, not LAN, under `NODE_ENV=production`. Stamped into `playbackUrl` of every local-storage row. |
| `STORAGE_ROOT` | REQUIRED PRODUCTION | Must **already exist as a directory** even when `STORAGE_DRIVER=r2` — boot stats it. On a fresh container, create it (or point at `/tmp/storage`) before first start. |
| `CORS_ORIGINS` | REQUIRED PRODUCTION | Must be **declared**; an **empty value is valid and correct** for mobile-only V1. Never `*` — it is rejected in every environment because the list is matched by string equality. Production entries must be bare https origins with no path/query/fragment/trailing slash. |
| `TRUST_PROXY_HOPS` | OPTIONAL (default `0`) | Set to the real proxy count — **`1` on any managed platform**. Non-negative integer; `0` is legal and means "no proxy". At `0` behind a proxy every per-IP limit collapses onto one bucket. Never `true`. |
| `DEV_TOOLS_ENABLED` | DEVELOPMENT ONLY | `true` is refused at boot unless `NODE_ENV` is exactly `development` or `test` (fail-closed allowlist). Opens `/dev/admin/*` self-service admin-role grant — privilege escalation. Also gates `/health/details`. |

### DATABASE

| Variable | Class | Notes |
|---|---|---|
| `DATABASE_URL` | REQUIRED PRODUCTION | In `REQUIRED_KEYS`. Deliberately **exempt** from the public-https rules — it is internal infrastructure and a private hostname is correct. Require TLS (`?sslmode=require`) on any hop leaving the provider network. |
| `DATABASE_URL_TEST` | TEST ONLY | **Preflight BLOCKER if set.** Its presence is what arms the retention job's destructive `--commit` path against a database. |

### REDIS

| Variable | Class | Notes |
|---|---|---|
| `REDIS_URL` | REQUIRED WHEN `TRANSCODE_ENABLED=true` | Shape-checked as `redis://` or `rediss://`; never connected to at boot. Exempt from the public-https rules for the same reason `DATABASE_URL` is. Unread when the flag is off. |

### STORAGE / R2

| Variable | Class | Notes |
|---|---|---|
| `STORAGE_DRIVER` | OPTIONAL (default `local`) | Named allowlist: `local` or `r2`. Staging wants `r2` — a container filesystem is empty on boot and discarded on deploy. |
| `OBJECT_STORAGE_ENDPOINT` | REQUIRED WHEN `STORAGE_DRIVER=r2` | Must be absolute http(s). **Under `NODE_ENV=production` it must additionally be public https** — every presigned GET is signed against it, so it becomes the `playbackUrl` of every R2 row and the `coverUrl` of every series. |
| `OBJECT_STORAGE_REGION` | REQUIRED WHEN `STORAGE_DRIVER=r2` | `auto` for R2. |
| `OBJECT_STORAGE_BUCKET` | REQUIRED WHEN `STORAGE_DRIVER=r2` | |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | REQUIRED WHEN `STORAGE_DRIVER=r2` | Secret. |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | REQUIRED WHEN `STORAGE_DRIVER=r2` | Secret. |
| `OBJECT_STORAGE_PUBLIC_BASE_URL` | OPTIONAL | **Not** required in r2 mode — it has no production caller. Only for a public bucket or custom media domain. If set in production it must still be public https. Leave empty for the intended private-bucket posture. |

### HLS

Only read when `TRANSCODE_ENABLED=true`. **`TRANSCODE_ENABLED=false` is a
fully valid V1 posture** and the preflight reports it as a PASS: HLS-ready
rows fall back to their R2 source.

| Variable | Class | Notes |
|---|---|---|
| `TRANSCODE_ENABLED` | OPTIONAL (default off) | Exact string `true`. Turning it on additionally requires Redis, an ffmpeg/ffprobe binary, a **separate worker process**, and a deployed gateway. |
| `HLS_GATEWAY_BASE_URL` | REQUIRED WHEN `TRANSCODE_ENABLED=true` | Absolute http(s); public https under production. Stamped into `masterUrl` and every rendition URL. |
| `HLS_TOKEN_SECRET` | REQUIRED WHEN `TRANSCODE_ENABLED=true` | Secret. Must be **byte-identical** to the gateway Worker's secret and **distinct** from all three auth secrets — boot refuses a collision, naming the two variables only. |
| `HLS_TOKEN_TTL_SECONDS` | OPTIONAL (default `3600`) | Positive integer if present. |
| `TRANSCODE_MAX_ATTEMPTS` | OPTIONAL (default `3`) | Positive integer if present; read only when the flag is on. |
| `TRANSCODE_STALLED_AFTER_MINUTES` | OPTIONAL (default `30`) | As above. |
| `TRANSCODE_CLEANUP_GRACE_MINUTES` | OPTIONAL (default `120`) | As above. |

### AUTH (core, no flag)

Email/password sign-in has no feature flag and must work in every
environment, which is why these three are unconditional.

| Variable | Class | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` | REQUIRED PRODUCTION | Secret. |
| `JWT_REFRESH_SECRET` | REQUIRED PRODUCTION | Secret. Also the HMAC key for refresh/reset/OTP tokens at rest. |
| `AUTH_AUDIT_IP_HASH_SECRET` | REQUIRED PRODUCTION | Secret. HMAC key for `Session.ipHash` / `AuthAuditEvent.ipHash`. |

**All three must differ from each other — enforced at boot**, not merely
documented. Generate each independently: `openssl rand -base64 48`. The
preflight additionally warns below 32 characters (length only; the value is
never read).

### GOOGLE

| Variable | Class | Notes |
|---|---|---|
| `GOOGLE_AUTH_ENABLED` | REQUIRED FOR V1 | Exact string `true`. Off is a preflight and release-gate **BLOCKER** — V1 ships Google login as a required sign-in method alongside WhatsApp, and off means `POST /auth/google` answers 503 with the login screen's Google button dead. The repo default stays `false`, and development/test still boot with it unset. |
| `GOOGLE_OAUTH_CLIENT_IDS` | REQUIRED FOR V1 | **Not a secret.** Comma-separated `aud` allowlist; at least one non-empty entry or boot fails. Graded as its own **BLOCKER** — an empty allowlist answers `401 INVALID_GOOGLE_TOKEN` to every real sign-in. Must contain the **web** client id — that is what both Android and iOS tokens are audienced to. See `docs/auth-identity-api-contract.md` §7.1. |

**CODE-CONFIGURED is not GOOGLE-VERIFIED.** A green preflight on these two
rows means the flag is on and at least one client id is present. It does not
mean the id exists in a Google Cloud project, that the OAuth consent screen is
published, or that the Android client carries the Play App Signing SHA-1 — no
tool in this repository contacts Google, and none claims to. Prove those with
one real Google sign-in against the deployed origin (§A4). Reports print a
COUNT of client ids, never the ids themselves.

No Google client **secret** exists anywhere in this codebase. This backend
only verifies ID tokens against Google's public JWKS; the code exchange
happens on the client.

### WHATSAPP

| Variable | Class | Notes |
|---|---|---|
| `WHATSAPP_AUTH_ENABLED` | REQUIRED FOR V1 | Exact string `true`. Off is a preflight **BLOCKER** — V1 ships WhatsApp as a required sign-in method, and off means every `/auth/whatsapp/*` route answers 503. |
| `WHATSAPP_OTP_PROVIDER_DRIVER` | REQUIRED WHEN enabled | Must be `cloud-api` for any real deployment. There is deliberately **no default**. |
| `WHATSAPP_CLOUD_API_PHONE_NUMBER_ID` | REQUIRED WHEN driver `cloud-api` | Numeric Graph id, **not** the phone number. Not a secret. |
| `WHATSAPP_CLOUD_API_ACCESS_TOKEN` | REQUIRED WHEN driver `cloud-api` | **The only secret in the WhatsApp config.** Permanent System User token. |
| `WHATSAPP_CLOUD_API_TEMPLATE_NAME` | REQUIRED WHEN driver `cloud-api` | Exact approved template name. |
| `WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE` | REQUIRED WHEN driver `cloud-api` | Exact approved language code, e.g. `id`. |
| `WHATSAPP_CLOUD_API_GRAPH_VERSION` | OPTIONAL | Validated as `v<major>.<minor>` **even while the feature is off**, because it is interpolated into the request URL. |
| `WHATSAPP_CLOUD_API_TEMPLATE_HAS_OTP_BUTTON` | OPTIONAL (**defaults ON**) | The one flag parsed as `!== 'false'` rather than `=== 'true'`. Set `false` only for a deliberately button-less template. |

`WHATSAPP_OTP_PROVIDER_DRIVER=fake` is refused at boot unless `NODE_ENV` is
exactly `development` or `test` — a fail-closed allowlist, checked **even
while the feature is disabled**. The fake driver retains plaintext codes in
memory and sends nothing.

### REWARDS

| Variable | Class | Notes |
|---|---|---|
| `REWARDS_ENABLED` | REQUIRED FOR V1 | Exact string `true`. Off is a preflight **BLOCKER** — V1 is free content + ads + rewards, and off means every `/rewards/*` route answers 503 and no watch credit is recorded. |
| `REWARDS_TIMEZONE` | OPTIONAL (default `Asia/Jakarta`) | Must resolve in `Intl`. Validated **unconditionally**, even while rewards are dark, because a typo would 500 every rewards request the moment the flag flips. |
| `REWARDS_SOCIAL_INSTAGRAM_URL` | REQUIRED FOR V1 | Preflight blocks if absent. |
| `REWARDS_SOCIAL_TIKTOK_URL` | REQUIRED FOR V1 | Preflight blocks if absent. |
| `REWARDS_SOCIAL_YOUTUBE_URL` | REQUIRED FOR V1 | Preflight blocks if absent. |
| `REWARDS_SOCIAL_FACEBOOK_URL` | OPTIONAL | Deliberately **not** required — its tile appears only if configured, and a release is never held for a platform the product did not ask for. |

Each social URL, **if set**, must be https, on that platform's own allowlisted
hosts, and point at a profile rather than the platform home page — or the boot
fails. The preflight additionally blocks a value still containing a template
segment such as `your-handle`. An **unset** URL is not an error at boot: it
means "this deployment does not run that mission", and the mission is omitted
from the snapshot entirely rather than served as a dead button.

### SECURITY / CONTENT POLICY

| Variable | Class | Notes |
|---|---|---|
| `CONTENT_ACCESS_MODE` | REQUIRED FOR V1 | Named allowlist: `free` or `entitlement`. Unset resolves to `entitlement`. **V1 requires `free`**, and the preflight now blocks anything else — see §3.5. |
| `PAYMENTS_ENABLED` | OPTIONAL (default off) | Out of V1 scope. `true` is a preflight WARNING. |
| `MIDTRANS_SERVER_KEY` | REQUIRED WHEN `PAYMENTS_ENABLED=true` | Secret. Not used in V1. |
| `MIDTRANS_IS_PRODUCTION` | OPTIONAL (default off) | `true` is refused at boot unless `NODE_ENV` is exactly `production` — checked even while payments are off. |
| `RETENTION_SCHEDULE_ENABLED` | OPTIONAL (default off) | Leave off unless deliberately operating the retention job. |
| `RETENTION_SCHEDULE_CRON` | OPTIONAL (default `0 3 * * *`) | |
| `RETENTION_SCHEDULE_COMMIT` | OPTIONAL (default off) | The destructive half. |

### ADS (public tuning for `GET /config/ads`)

All optional, all **warn-and-default** rather than fail-to-boot — a malformed
value logs a warning naming the variable and reverts to its default. None is a
credential. **The AdMob app id and ad unit ids live in the mobile build, never
here.**

| Variable | Default |
|---|---|
| `ADS_INTERSTITIAL_ENABLED` | `true` (unrecognised value → `true` + warn) |
| `ADS_MIN_VIDEOS_BETWEEN_ADS` | `3` |
| `ADS_MAX_VIDEOS_BETWEEN_ADS` | `6` |
| `ADS_MIN_SECONDS_BETWEEN_ADS` | `120` |
| `ADS_GRACE_VIDEOS` | `5` |

If min > max after parsing, **both** revert to their defaults plus a warning.

### NEVER SET IN A RUNNING SERVICE

`DATABASE_URL_TEST`, `RUN_R2_SMOKE`, `RUN_R2_MEDIA_SMOKE`, `RUN_R2_HLS_SMOKE`,
`SERIES_COVER_ORPHAN_APPLY_BUCKET`, `R2_MEDIA_MIGRATION_APPLY_BUCKET`,
`RUN_REDIS_QUEUE_CONTRACT`. The first five are **preflight BLOCKERS**. The
last two write-authorization gates must be supplied inline on the single
command that needs them, never baked into the service environment — a standing
authorization to write is exactly what they exist to prevent.

---

## 2. Release configuration matrix

| Setting | LOCAL DEV | STAGING | PRODUCTION |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` |
| `PUBLIC_BASE_URL` | `http://<LAN-IP>:3000` | https, real staging host | https, real production host |
| `CORS_ORIGINS` | empty | empty | empty |
| `TRUST_PROXY_HOPS` | `0` | `1` (managed platform) | `1` (managed platform) |
| `STORAGE_DRIVER` | `local` or `r2` | `r2` | `r2` |
| `OBJECT_STORAGE_*` | local MinIO or dev bucket | **separate staging bucket** | production bucket |
| `TRANSCODE_ENABLED` | `false` | `false` for first deploy | `false` until gateway + worker are proven |
| `HLS_GATEWAY_BASE_URL` | unset / LAN | unset until gateway deployed | https gateway origin |
| `GOOGLE_AUTH_ENABLED` | `false` or `true` | `true` | `true` |
| `GOOGLE_OAUTH_CLIENT_IDS` | unset or test values | **real web + platform client ids** | real web + platform client ids |
| `WHATSAPP_AUTH_ENABLED` | `true` | `true` | `true` |
| `WHATSAPP_OTP_PROVIDER_DRIVER` | `fake` | **`cloud-api`** | **`cloud-api`** |
| `REWARDS_ENABLED` | `true` | `true` | `true` |
| `REWARDS_TIMEZONE` | `Asia/Jakarta` | `Asia/Jakarta` | `Asia/Jakarta` |
| `REWARDS_SOCIAL_*_URL` | unset or test values | **real Red Panda profiles** | real Red Panda profiles |
| `CONTENT_ACCESS_MODE` | `free` | `free` | `free` |
| `PAYMENTS_ENABLED` | `false` | `false` | `false` |
| `DEV_TOOLS_ENABLED` | `true` | **`false`** | **`false`** |
| `DATABASE_URL_TEST` | set | **unset** | **unset** |
| `RETENTION_SCHEDULE_ENABLED` | `false` | `false` | `false` |

**Staging and production must never inherit a local setting.** Four are
structurally impossible to inherit — the boot refuses `DEV_TOOLS_ENABLED=true`
outside development/test, refuses `WHATSAPP_OTP_PROVIDER_DRIVER=fake` outside
development/test, refuses a cleartext/LAN `PUBLIC_BASE_URL` under production,
and refuses `MIDTRANS_IS_PRODUCTION=true` outside production. Two more are
caught by the preflight rather than the boot: `DATABASE_URL_TEST` being set,
and a `PUBLIC_BASE_URL` on a reserved/placeholder domain.

**Staging is not a smaller production; it is a separate one.** Use a separate
database, a separate bucket, separate auth secrets, and — if WhatsApp is
exercised at all — Meta's test number rather than the release sender.

---

## 3. External dependencies

Everything in this section is **outside this repository** and none of it has
been obtained. No credential in any category below has ever been exercised by
this code.

### 3.1 WhatsApp (Meta) — NOT STARTED

Staging needs, in order: a Meta developer account → a Business-type Meta App →
a WhatsApp Business Account → a **verified sender number** (yields
`WHATSAPP_CLOUD_API_PHONE_NUMBER_ID`) → a **permanent System User token** with
`whatsapp_business_messaging` (yields `WHATSAPP_CLOUD_API_ACCESS_TOKEN`) → an
**APPROVED AUTHENTICATION-category template** (yields
`WHATSAPP_CLOUD_API_TEMPLATE_NAME` and `..._TEMPLATE_LANGUAGE`). Full
procedure in `docs/WHATSAPP_LOGIN_SETUP.md`.

Notes that decide the schedule: template approval is a review process outside
this project's control and is the usual thing that delays a release — **start
it first**. The dashboard's 24-hour temporary token must not be shipped; when
it expires every WhatsApp login stops with `503
WHATSAPP_PROVIDER_UNAVAILABLE`. Authentication conversations are billed per
message in Indonesia.

**Fake delivery cannot reach staging.** With `NODE_ENV=production` the boot
refuses `WHATSAPP_OTP_PROVIDER_DRIVER=fake` outright, and with the flag on it
refuses a missing driver, an unimplemented driver, or a `cloud-api` driver
with an incomplete sender. There is no configuration in which a staging or
production process starts, answers `202` to an OTP request, and silently
delivers nothing.

**The one real OTP test, to be performed once after staging is deployed** (do
not perform it before — there is nothing to send from):

1. Deploy with the four sender variables set.
2. `POST /auth/whatsapp/otp/request` with a phone number you control (with a
   Meta test number, that handset must first be registered in the dashboard
   allowlist).
3. Confirm the message **arrives on the handset**. This is the only step that
   proves delivery; nothing in code or config can.
4. `POST /auth/whatsapp/otp/verify` with the code from the message.
5. Confirm an `accessToken` / `refreshToken` pair comes back.

If step 3 fails, the request returned `503 WHATSAPP_PROVIDER_UNAVAILABLE` and
the server log carries Meta's numeric error code (never the OTP, never the
full number). Common ones: `132001` template does not exist, `132015` template
paused, `190` token expired, `131026` recipient not reachable on WhatsApp.

Limits that shape the test: the code lives **5 minutes**, resend cooldown is
**60 seconds per number**, and the routes are rate-limited at **3 requests per
10 minutes** and **5 verifies per 60 seconds** per IP. Budget the attempts.

### 3.2 Rewards social profiles — NOT SUPPLIED

Staging needs the three official Red Panda profile URLs. They are **deployment
facts, not code**: a marketing team changing a handle must not need a release.

| Variable | Allowed hosts | Required for V1 |
|---|---|---|
| `REWARDS_SOCIAL_INSTAGRAM_URL` | `instagram.com`, `www.instagram.com` | **Yes** |
| `REWARDS_SOCIAL_TIKTOK_URL` | `tiktok.com`, `www.tiktok.com`, `m.tiktok.com` | **Yes** |
| `REWARDS_SOCIAL_YOUTUBE_URL` | `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be` | **Yes** |
| `REWARDS_SOCIAL_FACEBOOK_URL` | `facebook.com`, `www.facebook.com`, `m.facebook.com` | No |

Verified behaviour: with `REWARDS_ENABLED=true` and Instagram/TikTok/YouTube
absent, the preflight emits a **`social missions` BLOCKER** naming exactly the
missing variables. With one set to `https://www.instagram.com/your-handle` it
emits a **second, separate BLOCKER** for the template segment — that value is
a valid https URL on the right host with a non-empty profile path, so nothing
else rejects it, and shipping it would send every user who taps the tile to an
account Red Panda does not own **while paying them the points**.

**These missions do not verify a follow and the backend never claims they
do.** No platform exposes a follow check for an arbitrary user. A claim
records a user-confirmed external action: ledger reason
`EXTERNAL_SOCIAL_ACTION`, wire field `verification: "USER_CONFIRMED"`. If a
trusted integration ever exists, the honest upgrade is a **new** verification
value, never a redefinition of this one.

**Economics are unchanged by this work and are stated here only so staging can
verify them, not to invite retuning:**

| Item | Value |
|---|---|
| Daily check-in, days 1–7 | 10, 15, 20, 25, 30, 40, **100** (day 7 is the bonus day) |
| Check-in cycle length | 7 days, in `REWARDS_TIMEZONE` |
| Watch mission `task_watch_3_episodes` | 3 distinct episodes started → 30 points |
| Watch mission `task_watch_5_episodes` | 5 distinct episodes started → 50 points |
| Each social mission | 50 points, **once per account, ever** |
| Social claim minimum dwell | 5 seconds after `open` |
| `redeem_skip_next_ad` | **150 points** → 1 use, expires in 24h |
| `redeem_ad_pass_2h` | **600 points** → duration pass, 120 minutes |
| VIP redemptions (1d/3d/7d) | Present in the catalog but **suppressed entirely while `CONTENT_ACCESS_MODE=free`** — they would charge points to unlock content that is already free |

### 3.3 Google — CLIENT EXISTS IN CODE, EXTERNAL CONFIG NEEDED

**Required for V1, and a release blocker until supplied.** Both
`GOOGLE_AUTH_ENABLED=true` and a non-empty `GOOGLE_OAUTH_CLIENT_IDS` are
BLOCKING in `npm run production:preflight` and `npm run release:gate` — the
same standing WhatsApp login has, and the same standing the **mobile** release
preflight has always given Google.

An OAuth client for `com.spark.redpanda` plus the **Play App Signing SHA-1**.
Put the **web** client id in `GOOGLE_OAUTH_CLIENT_IDS`; add the Android and
iOS ids too if those builds ship. All ids are public. A backend allowlist
holding only the Android/iOS ids rejects every real token with `401
INVALID_GOOGLE_TOKEN` while both sides look correct — the single most likely
misconfiguration of this feature.

### 3.4 AdMob — NOT SUPPLIED, AND ENTIRELY MOBILE

The AdMob app id and ad unit ids go into the **Android build**. No AdMob SDK,
ad-network integration or ad-serving decision exists in this backend and none
should: it serves pacing config via `GET /config/ads` and records the two ad
perks points can buy. Nothing in §1 is an AdMob credential.

### 3.5 Free-catalog policy — A DECISION, NOT A CREDENTIAL

`CONTENT_ACCESS_MODE=free` is required for V1 and the preflight now blocks
anything else.

**Why this changed in this work.** Previously `free` produced a WARNING and
`entitlement` — including the unset default, and including the value the
shipped `.env.production.example` carried — produced a **PASS**. That graded
the V1 posture as the questionable one and the release-breaking posture as
clean. V1 ships no purchase flow of any kind (`PAYMENTS_ENABLED=false`, every
`/payments/*` route 503s, VIP redemptions suppressed in free mode), so under
`entitlement` every row whose `accessTierOverride` is `premium` is listed in
the feed and **permanently unplayable by anyone**. The catalog carries such
rows: the reference catalog is exactly 20 free and 20 premium episodes, so
half of it would have been dead while every other signal in the report was
green.

This is the same standing the WhatsApp and Rewards blockers already claim, and
the `.env.production.example` template now ships `free` to match. A deployment
that genuinely wants per-row enforcement sets `entitlement` deliberately and
accepts that its preflight blocks — that deployment is not this release.

---

## 4. Infrastructure contract

Nothing here selects a cloud provider. The only provider this repository
already assumes is **Cloudflare R2 + Workers**, and only because the storage
client and the HLS gateway are written against them.

| Component | Requirement | Status |
|---|---|---|
| **API process** | Node `>=22.0.0 <25.0.0`. Serves **plain HTTP** on `0.0.0.0:$PORT` — there is no TLS server anywhere in this codebase. Start: `npm run start:migrate:prod` (= `prisma migrate deploy && node dist/main`) or `npm run start:prod` when migrations are applied separately. | Code ready |
| **TLS / reverse proxy** | Something must terminate TLS in front of the API and forward to `$PORT`. Set `TRUST_PROXY_HOPS` to the real hop count. | Not provisioned |
| **Public API hostname** | One https origin, no trailing slash → `PUBLIC_BASE_URL`. Must not be loopback, LAN, or a reserved/placeholder domain. | **Not chosen — do not invent one** |
| **PostgreSQL** | A staging database **separate from every other environment**. Reachable over the platform's private network; TLS required if it leaves. Migration history applied via `prisma migrate deploy`. | Not provisioned |
| **Redis** | Only if `TRANSCODE_ENABLED=true`. `redis://` or `rediss://`. | Not needed for first deploy |
| **R2 bucket** | A **staging** bucket, private, `r2.dev` disabled, no custom domain. Backend needs endpoint/region/bucket/access key/secret. Presigned PUT/GET only. | Not provisioned |
| **HLS gateway Worker** | Only if `TRANSCODE_ENABLED=true`. Cloudflare Worker from `workers/hls-gateway`; copy `wrangler.toml.example` → `wrangler.toml`, bind the private bucket as `MEDIA_BUCKET`, set `HLS_TOKEN_SECRET` via `wrangler secret put` **byte-identical to the backend's**, keep `CACHE_ENABLED="false"`. `account_id` must never be committed. | Template only, **never deployed** |
| **Transcode worker** | Only if `TRANSCODE_ENABLED=true`. A **second process**, `node dist/worker/main`, plus an ffmpeg/ffprobe binary. The API does not transcode. | Code ready, not deployed |
| **ffmpeg / ffprobe** | Worker container only. | Not provisioned |

### Health endpoints

| Route | Auth | Behaviour |
|---|---|---|
| `GET /health` | public | **Liveness.** Always 200 while the process serves. Touches **nothing** — no DB, no storage, no Redis. Deliberate: a liveness probe that fails on a dependency outage tells the platform to restart, which cannot fix a database and turns an outage into a crash loop. |
| `GET /health/ready` | public | **Readiness.** `SELECT 1` against Postgres. 200 `{"status":"ready","database":"ok"}` or **503** `{"status":"not_ready","database":"unreachable"}`. Gate traffic on this one. The DB is the only dependency checked, deliberately — presigned URLs are signed offline and Redis is only connected when transcode is on. |
| `GET /health/details` | `DEV_TOOLS_ENABLED` | Uptime, versions, storage and transcode readiness. **Unreachable in staging/production by design** — the boot refuses to enable dev tools there. Do not build a staging check that depends on it. |

Point the platform's health check at `/health` and its traffic gate at
`/health/ready`.

---

## 5. Database: migration safety and the staging procedure

### 5.1 What the Rewards V1 migration does

`20260826140000_add_v1_reward_missions_and_perks` is the newest of **23**
migrations and the only one added since the last deployed line.

Adds three tables — `RewardMissionClaim`, `RewardWatchCredit`, `RewardPerk` —
and one column, `RewardRedemption.perkId`.

**It is additive.** No column is dropped, nothing is rewritten, and every new
column is nullable or defaulted, so it applies to a populated database without
touching a row.

Structural facts, verified against a real applied schema:

- **Foreign keys:** all three new tables carry `userId → User(id) ON DELETE
  CASCADE ON UPDATE CASCADE`. Deleting a user removes their mission claims,
  watch credits and perks.
- **Uniqueness — these are the anti-abuse controls, not conveniences:**
  - `RewardMissionClaim(userId, missionId, periodKey)` — one claim per mission
    per reward day (`*` for one-time missions), so a social mission pays once
    per account ever and a watch milestone once per day.
  - `RewardWatchCredit(userId, periodKey, videoId)` — replaying playback for
    the same episode all day yields exactly **one** credit, so progress only
    advances by reaching for a different episode.
  - `RewardMissionClaim.ledgerEntryId` and `RewardRedemption.perkId` are both
    unique — a double-issue is refused by the database, not merely by code.
- **Indexes:** `RewardMissionClaim(userId, claimedAt)`, `(missionId)`;
  `RewardWatchCredit(userId, periodKey)`; `RewardPerk(userId, status)`,
  `(expiresAt)`.
- **CHECK constraints:** `awardedPoints IS NULL OR > 0`; `openCount >= 0`;
  `remainingUses IS NULL OR >= 0`.

### 5.2 The one non-additive act, and why it is safe

The migration **drops** `RewardRedemption_grantsDays_positive` and replaces it
with `RewardRedemption_grantsDays_nonnegative` (`>= 0`).

This is a **widening**. The old constraint required every redemption to buy at
least one premium day, which was true when every offer was a VIP package. V1
adds `AD_PERK` offers that buy a perk and zero premium days, so the old
constraint would have refused every ad-perk receipt. The invariant that
actually mattered — a receipt never claims a *negative* benefit — is preserved.

Verified on a populated database after applying the migration:
`grantsDays = 0` is **accepted**; `grantsDays = -1` is still **refused** by
name.

### 5.3 Migration proof already performed

Both runs used **throwaway databases created for the purpose**. No shared
database was touched; the only statements ever issued against the existing
development databases were read-only `SELECT`s.

**Run A — zero → current.** Fresh empty database, `prisma migrate deploy`,
all **23** migrations applied in order. `prisma migrate status` → *Database
schema is up to date*. `prisma migrate diff` datasource → datamodel → **No
difference detected**.

**Run B — pre-Rewards → Rewards → current, on live data.** Fresh database, the
**22** pre-Rewards migrations applied in lexical order (18 tables, none of the
three V1 reward tables present). Representative rows inserted: a `User`, a
`RewardWallet` with a balance, a `RewardLedgerEntry`, and a `FULFILLED`
`RewardRedemption` for a VIP offer. Then the Rewards migration applied **on
top of that populated database**. Result: applied cleanly; all four row counts
unchanged; the existing redemption intact with `perkId` null; 21 tables;
`prisma migrate diff` datasource → datamodel → **No difference detected**.

### 5.4 Migration safety findings

1. **Rollback is forward-only in practice.** No down-migration exists — Prisma
   does not generate them and none was written. Reversing this migration means
   restoring a backup. The three tables can be dropped by hand without data
   loss to anything that existed before them, but `RewardRedemption`'s
   constraint swap would have to be reversed manually **and would then reject
   any ad-perk receipt written in the meantime**. Treat the backup as the
   rollback mechanism.
2. **`RewardRedemption.perkId` has no foreign key.** It is unique but
   unenforced — it references `RewardPerk.id` by convention only. Consistent
   with the Prisma schema, which declares no relation, and with
   `ledgerEntryId`/`entitlementId` alongside it. Consequence: nothing at the
   database level prevents a dangling `perkId`. Application code is the only
   control.
3. **`RewardWatchCredit.videoId` has no foreign key to `Video`.** Deleting a
   video leaves credits pointing at a row that no longer exists. They still
   count toward that day's watch mission. Harmless for V1 (the count is what
   matters, not the target), worth knowing before anyone purges catalog rows.
4. **The migration is safe to run concurrently with traffic** in the ordinary
   sense — `ADD COLUMN` of a nullable column and `CREATE TABLE` do not rewrite
   `RewardRedemption`. The `ALTER TABLE ... ADD CONSTRAINT ... CHECK` does take
   a brief `ACCESS EXCLUSIVE` lock and scans `RewardRedemption` to validate.
   On a staging-sized table that is milliseconds; on a large production table
   it is a lock to schedule rather than to ignore.

### 5.5 Staging database procedure — DO NOT RUN AGAINST ANYTHING SHARED

This has **not** been executed. Every step names what it verifies, because the
purpose of the sequence is that a wrong target is caught *before* the write.

**Step 1 — Back up first.**

```bash
pg_dump --format=custom \
  --file=staging-pre-rewards-$(date +%Y%m%dT%H%M%S).dump \
  "$STAGING_DATABASE_URL"
```

Verify the dump is non-empty and restorable *before* continuing. This is the
rollback mechanism; there is no other.

**Step 2 — Fingerprint the target. Read-only.**

```bash
psql "$STAGING_DATABASE_URL" -tAc \
  "SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), version();"
psql "$STAGING_DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
```

Confirm by eye that the database name is the staging one — not
`short_drama_dev`, not a production name, not a name you do not recognise.
**If the name is not the one you expected, stop.**

**Step 3 — Confirm the environment is staging, not production.**

```bash
psql "$STAGING_DATABASE_URL" -tAc "SELECT count(*) FROM \"User\";"
```

A staging database should hold test accounts, not a real user base.
Cross-check that `$STAGING_DATABASE_URL`'s host matches the staging platform's
private hostname and nothing else. Never run this procedure with a
`DATABASE_URL` resolved from a local `.env`.

**Step 4 — Migration status. Read-only; applies nothing.**

```bash
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate status
```

Expect a list of not-yet-applied migrations ending with
`20260826140000_add_v1_reward_missions_and_perks`. **If it reports drift or a
failed migration, stop** — resolve that before applying anything.

**Step 5 — Apply.**

```bash
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate deploy
```

Use `migrate deploy`, never `migrate dev` — the latter can reset a database.
For a platform that runs migrations at boot, `npm run start:migrate:prod` does
exactly this before starting the API.

**Step 6 — Validate after.**

```bash
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate status
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel   prisma/schema.prisma --exit-code
```

Expect *Database schema is up to date* and **No difference detected** (exit 0).
Then confirm the three tables and the widened constraint exist:

```bash
psql "$STAGING_DATABASE_URL" -tAc \
  "SELECT to_regclass('public.\"RewardMissionClaim\"'),
          to_regclass('public.\"RewardWatchCredit\"'),
          to_regclass('public.\"RewardPerk\"');"
psql "$STAGING_DATABASE_URL" -tAc \
  "SELECT conname FROM pg_constraint
    WHERE conrelid='public.\"RewardRedemption\"'::regclass AND contype='c';"
```

**Step 7 — Health.** `GET /health` → 200, `GET /health/ready` → 200 with
`database: "ok"`. A 503 here after a successful migration means the app cannot
reach the database it just migrated — check that the service and the migration
used the same connection string.

**Step 8 — Rewards smoke.** §7 below, at minimum the snapshot, one check-in,
and one perk redemption.

**Step 9 — Rollback.** Restore the Step 1 dump. See §10 for when to invoke it.

---

## 6. Content state

Measured read-only on this worktree's own development database. **Nothing was
migrated, uploaded or modified.**

The reconciled definition is preserved: **`objectStorageKey` — not the legacy
`storageKey` — is what determines R2 source readiness.** Every row has a
`storageKey`; that field says nothing about whether the bytes are reachable
from the public internet.

| Metric | This worktree's dev DB | The older dev DB where the HLS waves ran |
|---|---|---|
| Total `Video` rows | 40 | 44 |
| `contentKind='drama'` | 40 | 40 |
| `qa_fixture` rows | **0** | 4 |
| R2 source-backed (`objectStorageKey` set) | **0** | 19 |
| HLS-ready (`hlsMasterKey` set) | **0** | 18 |
| R2-backed but not yet HLS | 0 | 1 |
| Series (all active) | 4 | — |
| Access tier | 20 `free` / 20 `premium` | — |

**Read this carefully before planning a staging catalog.** The database this
branch is configured against has **no R2-backed media at all** — all 40
episodes exist only as local files under `STORAGE_ROOT` on one Mac. The R2 and
HLS work from earlier waves lives in a *different* local database, which is
also one migration behind (it has not received the Rewards V1 migration).

Consequences for staging:

- **A staging deployment pointed at a fresh database will have an empty
  catalog.** Content must be seeded, and its media uploaded to the staging
  bucket with `objectStorageKey` set, before anything can play.
- **A row with only a `storageKey` is unplayable on a container.** The Node
  process would serve it off `STORAGE_ROOT`, which on a container is an empty,
  ephemeral directory. This is the single most likely cause of "the API
  answers 200 but nothing plays".
- **The remaining migration backlog is therefore the whole catalog** for the
  database this branch uses: 40 of 40 episodes need R2 upload. See
  `docs/R2_MEDIA_MIGRATION.md`; that tool requires
  `R2_MEDIA_MIGRATION_APPLY_BUCKET` supplied inline on the one command.
- **The 4 `qa_fixture` rows must never reach staging.** They are excluded from
  the public feed by content kind; a staging seed that copies rows wholesale
  would reintroduce them.

---

## 7. Staging smoke matrix

Run after the first deploy, in this order — each group assumes the one above
passed. `WAITING EXTERNAL` means the check cannot run because a third party
has not provisioned something; it is **not** a failure and must never be
recorded as a pass either.

Note the rate limits before starting: 300 requests/60s globally per IP, 5
logins/60s, 3 WhatsApp OTP requests/10min, 5 OTP verifies/60s, 60 playback
URLs/min, 30 check-ins/min, 10 redemptions/min, 20 mission calls/min.

### HEALTH

| # | Check | Expected |
|---|---|---|
| H1 | `GET /health` | 200 `{"status":"ok","service":"short-drama-backend"}` |
| H2 | `GET /health/ready` | 200 `{"status":"ready","database":"ok"}` |
| H3 | `GET /health/details` | **404/403** — dev tools are off in staging. A 200 here means `DEV_TOOLS_ENABLED=true` leaked into staging: **stop the deploy.** |

### AUTH

| # | Check | Expected |
|---|---|---|
| A1 | `POST /auth/register` then `POST /auth/login` | Tokens returned. Email/password has no feature flag and must work. |
| A2 | `POST /auth/refresh` | New token pair. |
| A3 | `GET /auth/me` with the access token | The account. |
| A4 | `POST /auth/google` with a real Google ID token | 200 and tokens. **WAITING EXTERNAL** until the OAuth client and SHA-1 exist. A `401 INVALID_GOOGLE_TOKEN` with everything else correct almost always means the **web** client id is missing from `GOOGLE_OAUTH_CLIENT_IDS`. |
| A5 | `POST /auth/whatsapp/otp/request` | 202. **WAITING EXTERNAL** until Meta credentials exist. |
| A6 | Message arrives on the handset | **The only proof of delivery.** WAITING EXTERNAL. |
| A7 | `POST /auth/whatsapp/otp/verify` | Tokens. WAITING EXTERNAL. |
| A8 | `GET /auth/identities` | Linked providers for the account. |

### CONTENT

| # | Check | Expected |
|---|---|---|
| C1 | `GET /videos/feed` | 200, a list. |
| C2 | Feed contains **no** `qa_fixture` rows | Every entry is a real drama. A fixture in the feed is a **stop condition**. |
| C3 | `GET /series` and `GET /series/:id` | 200; `hasPremiumEpisodes` is **false** under `CONTENT_ACCESS_MODE=free`. |
| C4 | `GET /videos/:id` for a `premium` row | `accessTier` reports **`free`** — proves free mode is actually in effect. |
| C5 | `GET /config/ads` | 200 with a boolean `enabled` and the four pacing numbers. |

### PLAYBACK / HLS

| # | Check | Expected |
|---|---|---|
| P1 | `GET /videos/:id/playback` **without** an auth header | 200 — guest playback is the V1 posture. |
| P2 | The returned `playbackUrl` is fetchable | 200/206 with media bytes. If it 404s, that row is local-only — see §6. |
| P3 | `GET /videos/:id/playback` for an HLS-ready row | Carries `masterUrl` plus renditions. **WAITING EXTERNAL** until the gateway is deployed. |
| P4 | Master playlist fetch | 200. WAITING EXTERNAL. |
| P5 | 360p / 540p / 720p rendition playlists | Each 200. WAITING EXTERNAL. Note the ladder tops out where the source does — **no 1080p source exists in this catalog**. |
| P6 | Gateway rejects a tampered or expired token | 403/404 with no detail. WAITING EXTERNAL. |

`TRANSCODE_ENABLED=false` for the first deploy makes P3–P6 **not applicable**
rather than waiting — record them that way and move on.

### REWARDS

Requires a signed-in account.

| # | Check | Expected |
|---|---|---|
| R1 | `GET /rewards/snapshot` | 200: balance, check-in state, missions, offers. VIP offers **absent** (suppressed in free mode). |
| R2 | Social tiles present | Exactly the platforms whose URL is configured. Each carries `verification: "USER_CONFIRMED"`. |
| R3 | `POST /rewards/check-in` | Day 1 pays **10** points; balance and ledger both move. |
| R4 | `POST /rewards/check-in` again, same day | Idempotent replay — **no second payout**. |
| R5 | `POST /rewards/missions/:id/open` | 200, records the open, returns the destination URL. |
| R6 | Claim **immediately** (under 5s) | Refused — the minimum dwell. |
| R7 | `POST /rewards/missions/:id/claim` after 5s | 50 points, once. |
| R8 | Claim the same mission again | Refused — once per account, ever. |
| R9 | `GET /videos/:id/playback` for 3 distinct episodes, then claim `task_watch_3_episodes` | 30 points. |
| R10 | Replay playback of one already-credited episode | **No additional credit** — the anti-farming unique key. |
| R11 | `GET /rewards/ledger` | Every movement above, with `balanceAfter`. |
| R12 | `POST /rewards/redemptions` for `redeem_skip_next_ad` | 150 points debited, a perk issued, in one transaction. |
| R13 | Same redemption with the **same** idempotency key | Replay of the first result, not a second debit. |
| R14 | `POST /rewards/redemptions` with insufficient balance | Refused; balance unchanged. |
| R15 | `GET /rewards/perks` | The issued perk, `ACTIVE`, with `expiresAt`. |
| R16 | `POST /rewards/perks/:id/consume` | Perk becomes `CONSUMED`; a second consume is refused. |

### ADS CONTRACT

| # | Check | Expected |
|---|---|---|
| D1 | Perk state after R12 | `skipNextInterstitial: true`. |
| D2 | After consuming it (R16) | `skipNextInterstitial: false`. |
| D3 | Redeem `redeem_ad_pass_2h` (600 points) | `adFreeUntil` is an ISO timestamp ~120 minutes ahead. |
| D4 | With no active perk | `skipNextInterstitial: false`, `adFreeUntil: null`. |

### MUST NOT PASS

| # | Check | Expected |
|---|---|---|
| N1 | `GET /dev/admin/*` | Not reachable. A 200 is a **privilege-escalation stop condition**. |
| N2 | `POST /payments/*` | 503 `PAYMENTS_DISABLED`. |
| N3 | Any error body or log line containing a secret | None. Errors name variables, never values. |

---

## 8. Deployment order

Each step's stop condition is stated. Do not proceed past a stop.

1. **Obtain external dependencies** (§3). WhatsApp template approval first —
   it has the longest lead time and none of it is under this project's control.
2. **Provision infrastructure** (§4): database, bucket, host, DNS, TLS.
3. **Generate three independent auth secrets.** `openssl rand -base64 48`
   each. Never reuse one; the boot enforces distinctness.
4. **Assemble the staging environment** from `.env.production.example` and §2.
   Secrets go in the platform's secret store, never in git.
5. **Preflight the assembled configuration, before deploying anything:**
   ```bash
   env $(grep -v '^#' .env.staging | xargs) npm run production:preflight
   ```
   Read-only — no connection, no query, no bucket, no write, no secret
   printed. **Stop on any BLOCKER.** Exit 0 means the configuration is
   *code-valid*, which is a much weaker claim than working — see §11.
6. **Back up and migrate the database** (§5.5, steps 1–6). **Stop** if the
   fingerprint is not the staging database.
7. **Deploy the API process.** Point liveness at `/health`, traffic at
   `/health/ready`. **Stop** if readiness does not go green.
8. **Seed the catalog and upload media to the staging bucket** (§6). Until
   `objectStorageKey` is set, playback 404s regardless of how healthy the API
   is.
9. **Run the smoke matrix** (§7). **Stop** on any HEALTH, CONTENT or MUST NOT
   PASS failure.
10. **Perform the one real OTP test** (§3.1). Only this proves delivery.
11. **Only then** repoint the mobile build's `EXPO_PUBLIC_API_BASE_URL` (§9).
12. **HLS is a separate, later deployment.** Deploy the gateway Worker and the
    transcode worker, then flip `TRANSCODE_ENABLED=true` and re-run P3–P6.
    Never flip the flag before both processes exist — the API would mint
    tokens for a gateway that is not there.

---

## 9. Mobile configuration handoff

**This repository does not modify the mobile app.** The values below are what
the staging mobile build will need; supply them there, not here.

| Mobile variable | Value | Secret? |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | The staging API's https origin — the same value as the backend's `PUBLIC_BASE_URL`, no trailing slash | No |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | The **web** OAuth client id. **This is the load-bearing one on every platform** — it is what makes Google mint an ID token for the backend | No (ships in the binary) |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | The iOS client id — only if an iOS build ships | No |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Reversed iOS client id. Read by `app.config.js` at **build** time, never at runtime, and meaningless to this server | No |
| AdMob app id | From the AdMob console | No |
| AdMob ad unit id(s) | From the AdMob console | No |

**Cross-check:** every client id the app can cause Google to mint a token for
must also appear in the backend's `GOOGLE_OAUTH_CLIENT_IDS`, and all ids must
come from the **same** Google Cloud project. Android has no `EXPO_PUBLIC_*`
key — its client id is resolved by Play Services from the package name plus
signing certificate, so copy it from the console rather than from `.env`.

**Never put in a mobile bundle:** any `JWT_*` or `AUTH_AUDIT_*` secret,
`HLS_TOKEN_SECRET`, `WHATSAPP_CLOUD_API_ACCESS_TOKEN`, `OBJECT_STORAGE_*`
credentials, `DATABASE_URL`, `REDIS_URL`, or `MIDTRANS_SERVER_KEY`. A mobile
binary is readable by anyone who installs it.

---

## 10. Rollback and stop conditions

### Stop the deployment immediately if

- The preflight reports any **BLOCKER**.
- `prisma migrate status` reports **drift** or a failed migration.
- The database fingerprint in §5.5 step 2 is **not** the staging database.
- `GET /health/details` answers **200** — dev tools are enabled where they
  must not be, which means `/dev/admin/*` self-service admin-role grant is
  reachable.
- `GET /dev/admin/*` is reachable at all.
- A `qa_fixture` row appears in the public feed.
- Any error response or log line contains a secret value.
- `GET /videos/:id` reports `accessTier: "premium"` — free mode is not
  actually in effect and part of the catalog is unreachable.

### Roll back the migration by

**Restoring the §5.5 step 1 backup.** There is no down-migration, and writing
one after the fact is not a rollback — it is a new, untested migration. If
ad-perk redemptions have already been written, note that reversing the
`grantsDays` constraint would reject them.

### Roll back the release without touching the database by

Redeploying the previous API build. The Rewards V1 migration is additive, so
an older build runs against the migrated schema: it simply never reads the
three new tables or the `perkId` column. This is the cheaper rollback and
should be the first one tried.

### Disable a feature without redeploying by

- `REWARDS_ENABLED=false` → every `/rewards/*` route answers 503
  `REWARDS_DISABLED`; no watch credit is recorded. Balances and ledger rows
  are untouched.
- `WHATSAPP_AUTH_ENABLED=false` → `/auth/whatsapp/*` answers 503; Google and
  email/password keep working.
- `GOOGLE_AUTH_ENABLED=false` → `/auth/google` answers 503.
- Unset one `REWARDS_SOCIAL_*_URL` → that mission disappears from the snapshot
  and its claim route answers `REWARD_MISSION_UNAVAILABLE`.
- `TRANSCODE_ENABLED=false` → HLS-ready rows fall back to their R2 source.

Each of these is honest darkness rather than breakage. **Each also turns the
preflight red for a V1 release**, which is correct: a V1 without rewards or
WhatsApp is not V1.

---

## 11. What has been proven, and what has not

This distinction is the point of the whole document. Do not let one be read as
the other.

**`npm run release:gate` is the command that establishes this half of the
table** — it runs every offline check listed below in one pass and prints the
same distinction in its verdict. See `docs/V1_RELEASE_GATE.md`.

### CODE-VALID (proven offline, with no external service)

- The full migration history applies from zero and lands exactly on the
  datamodel; the Rewards migration applies to a **populated** pre-Rewards
  database without disturbing a row (§5.3).
- The boot contract accepts a structurally complete V1 configuration and
  refuses every incomplete posture it is designed to refuse.
- The preflight blocks a configuration missing WhatsApp, missing rewards,
  missing or placeholder social URLs, carrying a placeholder public URL,
  carrying `DATABASE_URL_TEST`, or running a non-free content mode — and
  reports **0 blockers** for a structurally complete one.
- Build, lint and the unit suite are green.
- The migration folder is internally consistent (every migration has non-empty
  SQL, timestamps increase monotonically, the lock provider matches the
  schema), and no loopback address, LAN address, reserved domain, template
  placeholder or hardcoded credential is compiled into release-bound source.

### EXTERNAL SERVICE VERIFIED (**nothing** — none of this has happened)

- No WhatsApp message has ever been sent by this code, to any number. The
  access token, the template approval and the sender's ability to reach
  WhatsApp are facts only Meta holds.
- No Google ID token from a real client has ever been verified. Verification
  is proven against generated keys and fixtures only.
- No staging database, bucket, host, DNS name or TLS certificate exists.
- The HLS gateway Worker has **never been deployed**; `wrangler.toml.example`
  is a template and no real `wrangler.toml` exists.
- No AdMob id has been supplied.
- The social profile URLs are not known, so no configured mission has ever
  pointed at a real Red Panda account.

A release-gate or preflight exit code of 0 means *this configuration would boot
and serve over HTTPS*. It does not mean the token works, the template is approved, the bucket
has bytes in it, or that anything plays on a phone. Only the smoke matrix
against a deployed origin, and one real OTP, can say that.
