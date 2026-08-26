# Production HTTPS Readiness

What has to be true before the Red Panda Android app stops talking to a Mac
on the office wifi and starts talking to a real HTTPS origin.

**No infrastructure described here is deployed.** Every hostname below is a
`<placeholder>` the release owner fills in. Nothing in this repository knows
the production domain, and nothing invents one.

Companion documents:
- `.env.production.example` — the environment contract, variable by variable.
- `docs/PRODUCTION_DEPLOYMENT_REQUIREMENTS.md` — runtime, database, resources.
- `docs/R2_MEDIA_MIGRATION.md` — moving catalog media into object storage.

---

## 1. Topology

```
  Android app (com.spark.redpanda)
        |
        |  HTTPS  ->  https://<api-domain>
        v
  ┌─────────────────────────────┐
  │ TLS terminator / proxy      │   platform-provided; NOT in this repo
  └─────────────┬───────────────┘
                |  plain HTTP, private network
                v
  ┌─────────────────────────────┐
  │ Red Panda API (Nest/Express)│   one process, listens 0.0.0.0:$PORT
  └──┬─────────┬─────────┬──────┘
     |         |         |
     v         v         v
  Postgres   R2 /     (Redis + HLS gateway
             S3        — V1 ships these OFF)
```

**This process never speaks TLS.** There is no TLS server anywhere in the
codebase: `src/main.ts` calls `app.listen(port, '0.0.0.0')` and nothing
else. HTTPS is therefore always terminated by something in front of it, and
that fact drives §5.

### Which URLs the client actually fetches

Four configured values become URLs the phone loads. Each is validated as a
public https origin at boot when `NODE_ENV=production`:

| Variable | Becomes | Live when |
|---|---|---|
| `PUBLIC_BASE_URL` | `playbackUrl` of every local-storage row | always |
| `OBJECT_STORAGE_ENDPOINT` | the origin of every presigned GET — `playbackUrl` for R2 rows **and** every series `coverUrl` | `STORAGE_DRIVER=r2` |
| `HLS_GATEWAY_BASE_URL` | `masterUrl` + every rendition URL | `TRANSCODE_ENABLED=true` |
| `OBJECT_STORAGE_PUBLIC_BASE_URL` | `StorageService.buildPublicUrl` (no production caller today) | when set |

`OBJECT_STORAGE_ENDPOINT` is the one that reads like internal plumbing and
is not: the AWS SDK **signs a URL against it** and that URL goes straight to
the client.

`DATABASE_URL` and `REDIS_URL` are deliberately **excluded** from these
rules. Nothing hands them to a client, and a platform's private hostname is
exactly the shape the public-URL rules reject.

---

## 2. Required production environment

The authoritative list is `.env.production.example`. In short:

**Required — the process will not start without them**

`PORT` · `PUBLIC_BASE_URL` · `STORAGE_ROOT` · `CORS_ORIGINS` ·
`DATABASE_URL` · `JWT_ACCESS_SECRET` · `JWT_REFRESH_SECRET` ·
`AUTH_AUDIT_IP_HASH_SECRET`

- `CORS_ORIGINS` must be **declared**, but **empty is valid** and is the
  correct answer for a mobile-only V1.
- The three secrets must all **differ from each other**; boot refuses
  otherwise, naming the two variables and never a value.

**Must hold exactly these values**

`NODE_ENV=production` · `DEV_TOOLS_ENABLED=false` ·
`WHATSAPP_OTP_PROVIDER_DRIVER=` (empty — the literal `fake` refuses to boot)

**Must never be set**

`DATABASE_URL_TEST` · `RUN_R2_SMOKE` · `RUN_R2_MEDIA_SMOKE` ·
`RUN_R2_HLS_SMOKE` · `SERIES_COVER_ORPHAN_APPLY_BUCKET`

---

## 3. HTTPS rules, and how they fail

Under `NODE_ENV=production`, each active public URL must be:

1. an absolute URL,
2. **https**,
3. not a loopback host (`localhost`, `127.0.0.1`, `::1`),
4. not a private/LAN host (RFC1918, `169.254/16`, `100.64/10`, `*.local`).

Violate any one and the process **refuses to boot**, naming the variable and
the offending origin (URLs are public information, so they are echoed;
secrets never are).

This is a boot-time failure on purpose. The alternative is worse: an `http://`
or LAN URL produces an API that answers **200 to everything**, passes its own
health check, passes the mobile release preflight — and never plays a single
episode, because Android 9+ blocks cleartext and a LAN address resolves to
nothing on a phone. There is no server-side symptom at all.

---

## 4. Local development is unaffected

Every rule above is gated on `NODE_ENV === 'production'` exactly, and asks
"is this definitely production?" — an unset, empty or misspelled value is
treated as *not* production. So local development keeps:

| | Local development | Production |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://<mac-lan-ip>:3000` | https, public |
| `CORS_ORIGINS` | `http://localhost:8082,…` | https origins, or empty |
| `OBJECT_STORAGE_ENDPOINT` | any http endpoint | https, public |
| `DEV_TOOLS_ENABLED` | `true` | must be `false` |
| WhatsApp OTP driver | `fake` | refuses to boot |

Two rules apply in **every** environment, because they are never right
anywhere: `CORS_ORIGINS=*` (see §6) and reusing one value for two auth
secrets.

---

## 5. Reverse proxy

`TRUST_PROXY_HOPS` is the number of proxies in front of this process. On any
managed platform that is normally **1**. The default is `0`, meaning "no
proxy", which leaves Express's `trust proxy` untouched.

**Set it.** Every per-IP control reads `request.ip`: the global throttler
(300/min), `LOGIN_RATE_LIMIT` (5/min), `WHATSAPP_OTP_REQUEST_RATE_LIMIT`
(3/10min), and the `Session.ipHash` / `AuthAuditEvent.ipHash` audit trail.
Left at `0` behind a proxy, every caller reports the *proxy's* address — the
five-logins-per-minute ceiling becomes five logins per minute for the entire
user base, and every audit row hashes one address.

**Never `trust proxy: true`.** Trusting the whole `X-Forwarded-For` chain
lets any client prepend a forged address and mint unlimited rate-limit
identities. A hop **count** makes Express skip exactly that many trusted
entries from the right, which a client cannot forge past. The variable is a
count for that reason, and a malformed value fails the boot rather than
silently falling back to 0.

`npm run production:preflight` warns when `PUBLIC_BASE_URL` is https and the
hop count is still 0 — a contradiction, since an https origin means
something terminates TLS in front of a process that only speaks HTTP.

---

## 6. CORS

**Empty is correct for V1.** The Android app is not a browser: it sends no
`Origin` header and CORS does not apply to it at all. The default is
deny-all — never `*`.

Add an origin only for a real browser client (a web admin). In production
each entry must be an exact `https://host[:port]` origin: no path, no query,
no fragment, **no trailing slash**. A browser's `Origin` header is always
exactly `scheme://host[:port]`, so `https://admin.<domain>/` — the shape
copied out of an address bar — silently matches nothing and looks like a
broken API rather than a typo. Boot rejects it and suggests the corrected
form.

`CORS_ORIGINS=*` is refused in **every** environment. This app parses the
variable into a *list*, and the `cors` package matches list entries by
string equality — so `*` allows an origin literally named `*`, i.e. nothing
at all. It fails safe, but silently and in the opposite direction from what
whoever typed it intended.

---

## 7. Auth transport

**Bearer tokens only. This backend sets no cookies at all** — there is no
`Set-Cookie` anywhere in `src/`, no session cookie, no refresh cookie, no
CSRF token. Access tokens are JWTs in the `Authorization` header; refresh
tokens are opaque random bytes, HMAC-hashed at rest in the `Session` table.

Consequences worth stating rather than leaving to be rediscovered:

- There are **no** `Secure` / `HttpOnly` / `SameSite` settings to get wrong.
- There is **no CSRF surface**: a browser cannot make an authenticated
  cross-site request against an API that ignores cookies.
- **Sticky sessions are unnecessary** — auth is stateless.

### External configuration each provider still needs

| Flow | State |
|---|---|
| Email / password | **READY IN CODE.** No flag, no external dependency; works in every environment. |
| Google | **READY IN CODE, NEEDS EXTERNAL CONFIG.** The ID-token verifier is fully implemented against Google's published JWKS. Needs `GOOGLE_AUTH_ENABLED=true` and `GOOGLE_OAUTH_CLIENT_IDS`. **No client secret is required or ever read** — verification needs only Google's public keys and the client id, so this backend cannot leak one. |
| WhatsApp | **NOT IMPLEMENTED.** The only driver is `fake`, which retains plaintext codes in memory and delivers nothing; boot refuses it outside development/test. WhatsApp sign-in therefore **cannot be enabled in production at all**, by construction. |
| Payments | **OUT OF V1.** `PAYMENTS_ENABLED=false`; every `/payments/*` route answers 503. |

Google additionally needs owner action outside this repository: an OAuth
client for `com.spark.redpanda`, the **Play App Signing SHA-1** (not only the
upload key's), and — if a web client is ever added — its own client id in the
same comma-separated list.

---

## 8. Health checks

| Route | Auth | Touches | Use |
|---|---|---|---|
| `GET /health` | none | nothing | **Liveness.** Restart the container if this fails. |
| `GET /health/ready` | none | one `SELECT 1` | **Readiness.** Hold traffic off this instance if this fails. |
| `GET /health/details` | `DEV_TOOLS_ENABLED` | DB + config | Operator view. **Unreachable in production** — the flag cannot be true there. |

`GET /health/ready` answers `200 {"status":"ready","database":"ok"}` or
`503 {"status":"not_ready","database":"unreachable"}`. It carries no
hostname, connection string, driver name, error text or stack: it is
readable by a load balancer and useless to anyone mapping the deployment.

The split matters. A liveness probe that failed on a database outage would
tell the platform to **restart** the container — which cannot fix a database
and turns a recoverable outage into a crash loop. Liveness therefore touches
nothing.

Only the database is checked, deliberately. Presigned URLs are signed
offline (no network call), and Redis is only ever connected when
`TRANSCODE_ENABLED=true`, which V1 does not ship. Checking either would make
readiness flap on a dependency this process can serve traffic without.

---

## 9. Preflight and acceptance

Two commands, at two different moments. Neither deploys anything.

```bash
# BEFORE deploying — judges a configuration you have not shipped yet.
# Read-only: no connection, no query, no bucket, no write. Prints no secret.
npm run production:preflight

# AFTER deploying — proves a live origin actually serves a guest.
API_BASE_URL=https://<api-domain> npm run smoke:production
```

`production:preflight` reports `PASS` / `WARNING` / `BLOCKER` and exits
non-zero on any blocker. It runs the real `validateEnv` rather than
re-implementing it, so it can never drift from what the process enforces,
and adds the checks a boot validator cannot make — notably **placeholder
domains**: `https://api.example.com` satisfies every https and public-host
rule and still resolves to nothing anyone owns.

It deliberately does **not** read `.env`. A preflight that absorbed the
developer's local file would grade the wrong configuration and pass. Supply
the real values explicitly:

```bash
env $(grep -v '^#' .env.production | xargs) npm run production:preflight
```

`smoke:production` exercises the whole anonymous-guest path and then checks
the thing nothing else checks: that the returned playback URL is https, is
not loopback/LAN, carries no filesystem path, and **actually serves bytes**
to a ranged GET.

---

## 10. Before the app switches from LAN to production

Ordered. Each step is verifiable; none is a judgement call.

1. **Own a domain and terminate TLS on it.** Point `<api-domain>` at the
   deployment. Owner-supplied — no code change.
2. **Fill in `.env.production`** from `.env.production.example`. Generate
   each secret independently (`openssl rand -base64 48`); all three must
   differ.
3. **Set `TRUST_PROXY_HOPS`** to the real number of proxies (1 on a typical
   managed platform).
4. **Run `npm run production:preflight`** against those values. Zero
   blockers, and read every warning.
5. **Migrate the media.** `STORAGE_DRIVER=r2` migrates nothing by itself —
   playback source is decided per row. Rows with only a `storageKey` are
   streamed off `STORAGE_ROOT`, which on a container is an empty ephemeral
   directory. See `docs/R2_MEDIA_MIGRATION.md`.
6. **Deploy and migrate the schema** (`npx prisma migrate deploy`, once per
   release).
7. **Verify the live origin**: `GET /health` → 200, `GET /health/ready` →
   200, then `API_BASE_URL=https://<api-domain> npm run smoke:production`.
8. **Only then** repoint the Android app's `EXPO_PUBLIC_API_BASE_URL`.

Google sign-in (OAuth client + Play signing SHA) and AdMob are independent
of this sequence and can land before or after; email/password sign-in and
guest playback do not depend on either.
