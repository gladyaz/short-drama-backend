# Play Store V1 — Integrated Backend

The single reference for the merged V1 backend line
(`integration/v1-auth-rewards`), the Red Panda V1 release integration
candidate.

It builds on `integration/playstore-v1-backend` — which joined the
HLS/transcoding work and the production-HTTPS work that had diverged at
`27b8389` — and adds the two completed V1 feature lines:

- `feat/v1-whatsapp-auth` — WhatsApp Login (Meta WhatsApp Cloud API OTP).
- `feat/v1-rewards-social` — the Rewards V1 earn-and-spend loop.

**RED PANDA V1 IS: free content + ads + rewards + Google Login + WhatsApp
Login, served over HLS.** There is NO payment, NO subscription, NO premium
paywall and NO coin purchase in V1. The entitlement and payment code paths
remain in the tree, switched off, because a later release needs them — they
are dormant architecture, not shipped product.

**Nothing described here is deployed.** Every hostname is a `<placeholder>`
the release owner fills in.

Companion documents:
- `docs/PRODUCTION_HTTPS.md` — topology, HTTPS rules, CORS, auth transport, preflight.
- `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` — runtime, database, resources.
- `docs/R2_MEDIA_MIGRATION.md` — moving catalog media into object storage.
- `docs/HLS_TRANSCODE_WAVE.md` — running a controlled transcode wave.
- `docs/WHATSAPP_LOGIN_SETUP.md` — what an operator must obtain from Meta.
- `docs/rewards-api-contract.md` — the rewards API, including §6 on why a
  social mission is `USER_CONFIRMED` and never a verified follow.
- `docs/auth-identity-api-contract.md` — the Google and WhatsApp sign-in
  contracts the mobile app codes against.

---

## 1. Production HTTPS requirements

Under `NODE_ENV=production`, every value that becomes a URL the phone fetches
must be an absolute **https** origin that is neither loopback nor
private/LAN. The process refuses to boot otherwise, naming the variable.

| Variable | Becomes | Enforced when |
|---|---|---|
| `PUBLIC_BASE_URL` | `playbackUrl` of local-storage rows | always |
| `OBJECT_STORAGE_ENDPOINT` | origin of every presigned GET — R2 `playbackUrl` **and** every series `coverUrl` | `STORAGE_DRIVER=r2` |
| `HLS_GATEWAY_BASE_URL` | `masterUrl` + every rendition URL | `TRANSCODE_ENABLED=true` |
| `OBJECT_STORAGE_PUBLIC_BASE_URL` | `StorageService.buildPublicUrl` | when set |

`DATABASE_URL` and `REDIS_URL` are exempt — they are internal infrastructure
and never handed to a client.

Also enforced at boot: `CORS_ORIGINS` must be declared (empty is valid and
correct for a mobile-only V1), `*` is refused in every environment, and the
three auth secrets must differ from one another.

`TRUST_PROXY_HOPS` must be the real number of proxies (1 on a typical
managed platform). Never `trust proxy: true`.

## 2. HLS architecture

```
  Android ──HTTPS──> Red Panda API ──mints token──> HLS gateway (Cloudflare Worker)
                          │                              │
                          │                              └──> R2 (private)
                          └──> Postgres, R2, Redis (queue, worker only)
```

The API never transcodes. A separate worker process (`dist/worker/main`)
consumes the BullMQ queue at concurrency 1. Ladder is 360p/540p/720p with a
1080p cap; the packager writes a master playlist, per-rendition variants and
a poster thumbnail, and the package validator rejects truncated and
cross-rendition playlists before anything is promoted.

`hls:wave-enqueue` runs a dry-run-first, answerable wave. `hls:demote`
reverses a bad live generation (scoped, dry-run first).

**`TRANSCODE_ENABLED=false` is a valid V1 posture** — HLS-ready rows simply
fall back to their R2 source. No Redis, no worker, no gateway required.

## 3. Storage precedence

One rule, test-locked in `playback-source.util.spec.ts` and
`videos.service.ts`:

```
HLS (processingState=ready + hlsMasterKey)
  └─> R2 (objectStorageKey)
        └─> local (storageKey, served by this process)
              └─> 409 MEDIA_PLAYBACK_SOURCE_UNAVAILABLE
```

**A legacy `storageKey` is inert once `objectStorageKey` exists.** 15 rows
carry both; none of them depends on a developer machine. "Has a storageKey"
never means "Mac-dependent".

## 4. Current real HLS-ready catalog

Audited read-only against the shared development database:

| series | videos | R2 source-backed | HLS-ready |
|---|---|---|---|
| series-101 | 10 | 10 | 10 |
| series-104 | 10 | 5 (ep01–05) | 5 |
| series-010 | 10 | 0 | 0 |
| series-105 | 10 | 0 | 0 |
| qa fixtures | 4 | 4 | 3 |
| **total** | **44** | **19** | **18** |

Every claimed HLS master exists in R2 (18/18). One fixture
(`media-11rqa-8ac6a7f3`) claims a source object that returns NotFound —
harmless today because HLS wins for that row, but it would fail if demoted.

## 5. CONTENT_ACCESS_MODE

| Value | Behaviour |
|---|---|
| unset / `entitlement` (default) | Per-row `accessTierOverride`, else episodes ≤ 5 free. Today: **15 free, 25 premium**. |
| `free` | `resolveAccessTier` returns `free` for **every** row, including rows explicitly marked premium. |

`free` **does** override the per-row tier — deliberately, and that is the
whole point of the mode. It is not a bypass: no database value changes, the
entitlement branch stays live, the same resolver feeds both the public
`accessTier` field and the playback gate (so the client is never told a tier
the server disagrees with), and unsetting the variable restores paid
behaviour instantly.

A malformed value fails the boot rather than guessing a mode.

## 6. R2 migration status and remaining backlog

**19 of 44 rows are R2 source-backed. The true remaining backlog is 25**, all
with a real local source and zero blocked:

- `series-010`: `video-010-01 … -10` (10)
- `series-104`: `video-104-06 … -10` (5)
- `series-105`: `video-105-01 … -10` (10)

Already-linked rows are never re-counted just because a legacy `storageKey`
remains.

```
npm run media:r2-migrate                          # read-only inventory
npm run media:r2-migrate -- --only=id1,id2        # scope to exact rows
npm run media:r2-migrate -- --only=… --upload     # write (needs R2_MEDIA_MIGRATION_APPLY_BUCKET)
```

**Not all 25 must migrate before first release.** What must be playable is
what a V1 user can reach. With `CONTENT_ACCESS_MODE` at its default, that is
the 15 free episodes — 10 of which are already R2/HLS-backed. Set the mode to
`free` and the whole visible catalog becomes reachable, which raises the bar
to all 40 drama rows. Decide the mode first; it changes the content scope.

## 7. Fixture-content rule

`contentKind` separates catalog content from internal fixtures.

- **Listing routes exclude fixtures server-side**: `GET /videos/feed`,
  `GET /series`, `GET /series/:id` episodes.
- **Direct-addressing routes still serve them**: `GET /videos/:id`,
  `/videos/:id/playback`, `/videos/:id/stream` — internal tooling depends on
  this (`hls:real-media-proof` exercises `/videos/:id/playback` against
  seeded fixture rows).

Fixture rows are never deleted. Before this integration the feed did not
filter, so 4 published fixtures reached ordinary viewers as episodes.

## 8. Auth and monetisation

| Flow | Status |
|---|---|
| Email / password | **READY IN CODE.** No flag, no external dependency. |
| Google | **READY IN CODE, NEEDS EXTERNAL CONFIG.** Real JWKS verifier. Needs `GOOGLE_AUTH_ENABLED=true` + `GOOGLE_OAUTH_CLIENT_IDS`, an OAuth client for `com.spark.redpanda`, and the **Play App Signing SHA-1**. No client secret is required or ever read. |
| WhatsApp | **READY IN CODE, NEEDS EXTERNAL CONFIG (Meta).** The production `cloud-api` driver (Meta WhatsApp Cloud API) ships and is fully tested. It cannot run until an operator obtains real Meta credentials — see "WhatsApp external requirements" below and `docs/WHATSAPP_LOGIN_SETUP.md`. The `fake` driver still exists for local/test only, and boot refuses it outside `NODE_ENV=development/test`. |
| Payments | **OUT OF V1.** `PAYMENTS_ENABLED=false`; `/payments/*` answers 503. |
| Ads (AdMob) | External. Owner supplies the AdMob app id and unit ids to the mobile app; the backend only serves pacing config via `GET /config/ads`. |
| Rewards | **READY IN CODE, NEEDS CONFIG.** Set `REWARDS_ENABLED=true` plus the three `REWARDS_SOCIAL_*_URL` values. Earn: daily check-in, social follow missions (Instagram/TikTok/YouTube), watch milestones. Spend: ad-skip and temporary ad-pass perks. See `docs/rewards-api-contract.md`. |

**V1 monetisation is free content + ads + rewards.** There is no paywall, no
subscription and no coin purchase. Coins are earned only through the three
paths above and spent only on ad perks; the VIP redemptions in the catalog are
withheld entirely while `CONTENT_ACCESS_MODE=free`, because unlocking content
that is already free would charge points and change nothing.

### WhatsApp external requirements — NOT YET SATISFIED

Nothing below can be invented, generated, or worked around in code. The
backend is complete; these are the facts only Meta holds.

| Needed from Meta | Variable |
|---|---|
| WhatsApp Business sender's Graph API **Phone number ID** | `WHATSAPP_CLOUD_API_PHONE_NUMBER_ID` |
| **System User access token** (permanent, `whatsapp_business_messaging`) | `WHATSAPP_CLOUD_API_ACCESS_TOKEN` — **secret** |
| An **approved AUTHENTICATION-category template** | `WHATSAPP_CLOUD_API_TEMPLATE_NAME` |
| That template's approved language code | `WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE` |

**This provisioning has NOT been done.** No Meta account, app, sender number,
token or template exists for this project yet, and no fake value for any of
them ships in this repository. `npm run production:preflight` reports a
`BLOCKER` until all four are set, and it can only check that they are
PRESENT — whether the token is valid, whether the template is approved and
un-paused, and whether the number can actually send are unknowable from
configuration. **One real end-to-end OTP to a handset you control is the only
proof of delivery**, and it has not been performed.

### Rewards external requirements — NOT YET SATISFIED

| Needed from the product owner | Variable |
|---|---|
| Official Red Panda **Instagram** profile URL | `REWARDS_SOCIAL_INSTAGRAM_URL` |
| Official Red Panda **TikTok** profile URL | `REWARDS_SOCIAL_TIKTOK_URL` |
| Official Red Panda **YouTube** channel URL | `REWARDS_SOCIAL_YOUTUBE_URL` |

**These URLs have NOT been supplied.** No real Red Panda social account URL
appears anywhere in this repository. Facebook
(`REWARDS_SOCIAL_FACEBOOK_URL`) is **optional** — V1 specifies Instagram,
TikTok and YouTube only, and a release is never blocked for omitting a
platform the product did not ask for.

Boot refuses a URL that is not https, is not on that platform's own domains,
or points at a platform home page instead of a profile. The preflight
additionally **BLOCKS** a release whose URL still carries a template segment
such as `your-handle`, and **BLOCKS** a release missing any of the three V1
platforms.

### Ads external requirements — NOT YET SATISFIED

AdMob configuration is **entirely mobile/external**. The owner supplies the
AdMob app id and ad unit ids to the Android app. **No AdMob SDK, no ad-network
integration and no ad-serving decision exists in this backend, and none
should** — the backend only serves pacing config via `GET /config/ads` and
records the two ad perks a user has bought with points. These ids have not
been supplied.

**Social missions are user-confirmed, not verified.** No platform exposes a
"did user X follow page Y" check for an arbitrary user, so the server records
that it handed out the link and that the user came back and confirmed —
nothing more. The ledger reason is `EXTERNAL_SOCIAL_ACTION` and the API sends
`verification: "USER_CONFIRMED"`. This is stated here because it is a product
decision the owner is making, not an implementation detail.

## 9. Health and preflight

| Route | Auth | Touches |
|---|---|---|
| `GET /health` | none | nothing (**liveness**) |
| `GET /health/ready` | none | one `SELECT 1` (**readiness**, 200/503) |
| `GET /health/details` | `DEV_TOOLS_ENABLED` | DB + config — unreachable in production |

```
npm run production:preflight                       # before deploy, read-only
API_BASE_URL=https://<origin> npm run smoke:production   # after deploy
```

The preflight reports `PASS`/`WARNING`/`BLOCKER`, exits non-zero on blockers,
prints no secret, and reports every integrated posture.

**IT ENFORCES THE V1 RELEASE POLICY, AND THAT IS NEW IN THIS MERGE.** Each
feature branch, on its own, could only state its posture and let a human
judge — a branch has no standing to decide whether a release without it is
still the release. The integration settles it, so these are now **BLOCKERS**:

| Posture | Verdict |
|---|---|
| `WHATSAPP_AUTH_ENABLED` not `true` | **BLOCKER** — V1 ships WhatsApp login as a required sign-in method |
| WhatsApp enabled, driver missing / `fake` / unimplemented | **BLOCKER** (the boot contract also refuses it) |
| `cloud-api` with any of the four sender variables missing | **BLOCKER**, naming the variables — never their values |
| `REWARDS_ENABLED` not `true` | **BLOCKER** — V1 is free content + ads + rewards |
| Any of Instagram / TikTok / YouTube URL missing | **BLOCKER**, naming which |
| A social URL still carrying `your-handle` | **BLOCKER** |
| `REWARDS_SOCIAL_FACEBOOK_URL` missing | not required, not counted |
| `CONTENT_ACCESS_MODE=free`, HLS off, Google off | `WARNING` — deliberate postures |

**These are RELEASE rules, not BOOT rules.** `validateEnv` still starts a
process with both features switched off, and development and test still run
with no Meta credentials and no social URLs at all. Nothing was weakened to
get here: postures that used to warn now block, and no blocker became a
warning.

## 10. Remaining before release

Code is not the blocker. What remains is owner/external:

1. Production domain, DNS, TLS host; production Postgres; R2 credentials.
2. Three independently generated auth secrets.
3. Google OAuth client + Play App Signing SHA-1.
4. AdMob ids; privacy-policy and account-deletion URLs.
4b. The three official Red Panda social profile URLs (Instagram, TikTok,
   YouTube), for `REWARDS_SOCIAL_*_URL`. **Not yet supplied.** Until they are
   set the preflight blocks the release, and the missions are not served.
4c. **Meta WhatsApp Cloud API provisioning — not yet started.** A Meta app, a
   WhatsApp Business sender number, a permanent System User access token, and
   an APPROVED authentication-category template. See
   `docs/WHATSAPP_LOGIN_SETUP.md`. Template approval is a review process with
   a lead time that is outside this project's control, so it is the
   longest-lead external item in this list.
4d. **One real end-to-end WhatsApp OTP** to a handset you control, after
   provisioning. Preflight and the test suite prove the code; only a real
   message proves delivery.
5. Decide `CONTENT_ACCESS_MODE`, then migrate the content that decision makes
   user-visible.
6. **Physical Android device HLS QA** — paused while the device is
   unavailable. Real-device playback of an HLS-ready episode
   (`series-101`/`series-104` ep01–05) over the production gateway has not
   yet been observed; every HLS proof so far is server-side.
