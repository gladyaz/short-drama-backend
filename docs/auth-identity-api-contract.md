# Auth Identity API Contract — Phase 10B/10C (Production Identity Providers)

**Status: implemented and tested. Reconciled against the mobile client in
Phase 10C.** This document is the authoritative contract for every
authentication route this backend exposes, covering all THREE supported
methods:

1. **Email + password** — unchanged, still primary, still always available.
2. **Google OAuth / OIDC** — flag-gated, off by default.
3. **WhatsApp OTP** — flag-gated, off by default.

All three resolve to the **same internal `User`** and issue the **same
`accessToken` / `refreshToken` / `Session`**. There is no such thing as a
"social session" in this system.

Nothing here is aspirational: every route, field, status and error code below
exists in the repository today and is covered by tests.

**PHASE 10C — THIS DOCUMENT IS THE SINGLE SOURCE OF TRUTH FOR BOTH SIDES.**
The backend (`0fee0ee`) and the mobile client (`mobile-app-ecc` @ `9a1d1ae`)
built their provider-auth surfaces in parallel, and they did not agree. The
mobile side's paths, field names and error codes were explicitly
**provisional** — marked so in its own source ("PROVISIONAL CONTRACT … the
mobile side's proposal … None of it is confirmed by a deployed backend yet")
and **never served by any deployed backend**; its own contract doc carries a
`STATUS: PROVISIONAL — NOT CONNECTED TO A DEPLOYED BACKEND` banner. Every
path is constructed inside a single client module, so nothing outside that
module needs to change to adopt the canonical routes.

That is not the same as "unused". `LinkedMethodsCard` **is mounted** on the
Account Security screen and calls `GET /auth/methods` on every mount, so
that card fails against this backend today. Fixing it is part of §10, not a
future nicety.

This document resolves every disagreement in favour of the routes that are
actually implemented, tested and hardened here. §9 records what changed on
the backend for the reconciliation, and §10 is the exact, mechanical edit
list for mobile.

---

## 1. The one-sentence summary of the security model

> A provider proves an **identity**; only an authenticated Short Drama
> session can **link** that identity to an existing account.

Matching strings never link accounts. See §6.

---

## 2. Data model

```
User
  id, email?, passwordHash?, displayName?, role, createdAt, updatedAt

AuthIdentity            (one row per way an account can sign in)
  id, userId, provider, providerSubject, normalizedIdentifier?,
  createdAt, verifiedAt?
  UNIQUE (provider, providerSubject)     <- one identity, at most one account
  UNIQUE (userId, provider)              <- at most one identity per provider

PhoneOtpChallenge       (no owning user, by design — see §5)
  id, phoneE164, codeHash, expiresAt, attemptCount, consumedAt,
  createdAt, ipHash?
  liveKey?                               <- = phoneE164 while live, NULL once
  UNIQUE (liveKey)                          consumed: at most ONE live
                                            challenge per number, enforced
                                            by the database
```

`provider` is a closed set: `email` | `google` | `whatsapp`.

`providerSubject` is the provider's authoritative identifier — the Google
`sub` claim, the E.164 phone number, or the lowercased email. **Never a
display name, never anything the client chose.**

`User.email` and `User.passwordHash` are **nullable** as of this phase. A
WhatsApp-only account has neither; a Google account has an email only when
Google asserted `email_verified`.

---

## 3. Endpoints

### 3.1 Email + password (UNCHANGED — preserved exactly)

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | — | `201` | Explicit registration. Also creates the account's `email` `AuthIdentity`. |
| POST | `/auth/login` | — | `200` | **Existing accounts only.** Never creates a user. |
| POST | `/auth/refresh` | — | `200` | Rotation + reuse detection, unchanged. |
| POST | `/auth/logout` | — | `200` | Idempotent. |
| POST | `/auth/logout-all` | Bearer | `200` | Revokes every session including the caller's. |
| GET | `/auth/me` | Bearer | `200` | |
| GET | `/auth/sessions` | Bearer | `200` | |
| DELETE | `/auth/sessions/:id` | Bearer | `204` | |
| POST | `/auth/change-password` | Bearer | `200` | |
| POST | `/auth/password-reset/request` | — | `202` | Always `202`. |
| POST | `/auth/password-reset/confirm` | — | `200` | |
| POST | `/users/me/deletion` | Bearer | `200` | |
| GET | `/users/me/export` | Bearer | `200` | Now also lists linked identities. |

**LOGIN NEVER REGISTERS.** An unknown email and a wrong password both return
`401 INVALID_CREDENTIALS` and write nothing. This is asserted directly, by
row count, in `auth-identity.service.spec.ts` ("an INVALID login NEVER
creates a user").

### 3.2 Google

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/auth/google` | — | `200` |
| POST | `/auth/identities/google/link` | Bearer | `200` |

Request body for both: `{ "idToken": "<Google ID token>" }` — **that one
field and nothing else.** The global whitelisting `ValidationPipe` rejects
any additional field with `400`, so a client can never hint at an email or
subject.

`POST /auth/google` returns `200` whether it signed in or signed up. The
status deliberately does not vary by outcome: a client cannot branch on it
usefully, and a varying status would be an account-existence oracle.

### 3.3 WhatsApp

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/auth/whatsapp/otp/request` | — | `202` |
| POST | `/auth/whatsapp/otp/verify` | — | `200` |
| POST | `/auth/identities/whatsapp/link` | Bearer | `200` |

Request bodies: `{ "phone": "0812..." }` and `{ "phone": "...", "code":
"123456" }`.

`otp/request` response:

```json
{ "success": true, "expiresInSeconds": 300, "resendAvailableInSeconds": 60 }
```

**There is no `challengeId`, and there will not be one.** A challenge is keyed
by the PHONE NUMBER, and at most one is live per number — enforced by the
database, not by application code (see §5). The number the client already
holds *is* the handle, so `verify` takes `{ phone, code }`. Handing out an
opaque challenge id would add a second lookup key for the same row and make
it possible to address a challenge that is no longer the live one, which is
exactly the invariant `liveKey` exists to make unrepresentable.

**Both timing fields are fixed public constants** (`OTP_TTL_MS`,
`OTP_RESEND_COOLDOWN_MS`), identical for every caller and every number.
`resendAvailableInSeconds` is the FULL cooldown, never the remaining time on
a pre-existing challenge — a remaining-time value would vary with the
number's recent history and become a "somebody recently requested a code for
this number" oracle on the `202` path. It exists so a client renders its
resend countdown from the server's rule instead of a constant of its own that
would silently drift. Asserted deep-equal, with identical status, for a
registered and an unregistered number in `auth-identities.e2e-spec.ts`
("OTP-start answers identically for a number with an account and one
without").

> **`resendAvailableInSeconds` IS A MINIMUM WAIT, NOT PERMISSION TO SEND.**
> It reports the per-NUMBER cooldown and nothing else. Two other limiters
> (§5) sit beside it and can both make the real wait longer:
>
> - **the per-IP route throttle — 3 per 10 minutes.** This is the one an
>   ordinary user actually reaches: one send plus two resends exhausts it.
>   Its `429` is produced by the framework throttler, so it carries
>   **`code: "HTTP_ERROR"`, not `OTP_RESEND_COOLDOWN`** — status, not code,
>   is the reliable signal for this case (the same convention
>   `POST /users/me/deletion` already documents).
> - **the per-number rolling budget — 5 per hour.** The 5th accepted request
>   still answers `60`, while the next acceptance can be nearly an hour away.
>
> A client MUST therefore keep handling `429` on resend and must not treat a
> finished countdown as a guarantee. The mobile client already does the right
> thing here: it branches on `error.status === 429` before inspecting
> `error.code`, and re-locks its countdown rather than leaving the button
> pressable. Computing a truthful "next acceptance" instead would require
> reading the number's request history back to the caller — precisely the
> recent-activity oracle this endpoint refuses to be.

`devCode` is added **only** when `DEV_TOOLS_ENABLED=true` **and** `NODE_ENV`
is exactly `development` or `test` — the identical gate
`POST /auth/password-reset/request`'s `devToken` already uses.

### 3.4 Identity management

| Method | Path | Auth | Success |
|---|---|---|---|
| GET | `/auth/identities` | Bearer | `200` |
| DELETE | `/auth/identities/:provider` | Bearer | `200` |

`:provider` accepts only `google` or `whatsapp`. `email` is rejected `400`:
an email identity is inseparable from `User.email`/`User.passwordHash`, whose
lifecycle belongs to the register / change-password / password-reset /
account-deletion flows.

Listing shape:

```json
[
  { "provider": "email",    "identifier": "person@example.com",
    "usable": true, "canBeUnlinked": false,
    "createdAt": "...", "verifiedAt": null },
  { "provider": "whatsapp", "identifier": "+*********7890",
    "usable": true, "canBeUnlinked": true,
    "createdAt": "...", "verifiedAt": "..." }
]
```

`identifier` is `string | null` — `null` when the provider asserted nothing
safely displayable (a Google account whose email was not verified). Treat it
the same way as `user.email` in §3.5: always present, not always a string.

```json
{ "provider": "google", "identifier": null,
  "usable": true, "canBeUnlinked": true,
  "createdAt": "...", "verifiedAt": "..." }
```

The raw `providerSubject` is **never** returned for `google` or `whatsapp` —
a Google `sub` is withheld entirely and a phone number is masked to its last
four digits. For `email` it is the caller's OWN address, which is
byte-identical to `normalizedIdentifier` and already present as `user.email`,
so nothing is disclosed that the caller did not supply.

`canBeUnlinked` is computed server-side by the same rule `DELETE` enforces,
so a client rendering the button off this flag and the server can never
disagree.

### 3.5 Session response and user response (IDENTICAL for all three methods)

Every successful authentication — `register`, `login`, `refresh`,
`change-password`, `POST /auth/google`, `POST /auth/whatsapp/otp/verify` —
returns exactly this, and nothing else:

```json
{
  "user": { "id": "clx…", "email": "person@example.com", "displayName": "Jane" },
  "accessToken": "<JWT, ~15 min, payload is only { sub }>",
  "refreshToken": "<opaque high-entropy string, returned once, only its keyed hash is stored>"
}
```

`GET /auth/me` returns the `user` object alone.

**`user.email` is `string | null`, and the key is ALWAYS PRESENT.** This is
the one shape decision a client must not get wrong, so it is stated as a
rule rather than left to an example:

| Account created by | `user.email` |
|---|---|
| `POST /auth/register` | the registered address — as it always was |
| `POST /auth/google`, token with `email_verified: true` | the verified Google address |
| `POST /auth/google`, token WITHOUT `email_verified` | `null` |
| `POST /auth/whatsapp/otp/verify` | `null` |

Chosen over omitting the key: a present-but-`null` field is one shape for
every account, so a client destructures unconditionally and only its TYPE has
to admit `null`. An optional key would additionally make "absent" and
"null" separately meaningful for no gain.

**No synthetic address is ever invented for a phone-only account** — not
`+62811…@whatsapp.local`, not anything else. A fake address in `User.email`
would be indistinguishable from a real one to `POST /auth/password-reset/request`
and to the §6 collision check, creating a password-reset surface for an
account that has no password. The human-readable label for such an account is
the MASKED `identifier` on `GET /auth/identities` (§3.4), which is precisely
why that field exists.

`displayName` remains optional and is omitted when unset — unchanged.

Pinned end-to-end by `auth-identities.e2e-spec.ts` ("a phone-only account
reports email: null — never a synthetic address"), which asserts the field on
the verify response, on `GET /auth/me`, and on the stored row.

---

## 4. Error codes

| Code | Status | Meaning |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Email login failed — any reason. |
| `EMAIL_ALREADY_REGISTERED` | 409 | Duplicate registration. |
| `INVALID_GOOGLE_TOKEN` | 401 | Google token failed verification — **any** reason. |
| `GOOGLE_AUTH_DISABLED` | 503 | Google not configured on this server. |
| `INVALID_PHONE_NUMBER` | 400 | Not normalizable to E.164. Shape only; no DB access. |
| `INVALID_OTP` | 401 | OTP failed — **any** reason. |
| `OTP_RESEND_COOLDOWN` | 429 | Per-number cooldown or rolling budget. |
| `WHATSAPP_AUTH_DISABLED` | 503 | WhatsApp not configured on this server. |
| `AUTH_ACCOUNT_LINK_REQUIRED` | 409 | Provider email collides with an existing account. |
| `AUTH_IDENTITY_ALREADY_LINKED` | 409 | That identity belongs to a different account. |
| `AUTH_PROVIDER_ALREADY_LINKED` | 409 | This account already has a different identity for that provider. |
| `AUTH_LAST_IDENTITY` | 409 | Would leave the account with no way to sign in. |
| `AUTH_IDENTITY_NOT_FOUND` | 404 | Caller has no identity for that provider. |

**Deliberately generic codes.** `INVALID_GOOGLE_TOKEN` covers a bad
signature, wrong audience, expired token, bad issuer and missing subject
alike; `INVALID_OTP` covers wrong code, expired, exhausted, already-used and
no-challenge alike. Splitting either would tell an attacker which check to
defeat next, or turn the OTP endpoint into a phone-number enumeration
oracle. The **specific** cause is recorded server-side in `AuthAuditEvent`.

---

## 5. Rate limiting

Two independent layers, and the distinction matters:

**Per-IP (`@Throttle()`, in-memory, per instance)** — cheap outer layer,
defeated by rotating IPs:

| Route | Limit |
|---|---|
| `POST /auth/google` | 10 / min |
| `POST /auth/whatsapp/otp/request` | 3 / 10 min |
| `POST /auth/whatsapp/otp/verify` | 5 / min |

**The two LINK routes deliberately carry no override** and fall under the
app-wide default throttler, like every other authenticated route
(`change-password`, `logout-all`, `sessions`). They are a second door onto
the same primitives — `identities/whatsapp/link` consumes an OTP attempt and
`identities/google/link` runs full ID-token verification — so it is worth
stating why that is sufficient rather than leaving a reader to re-derive it:

- They require a valid access token, so they are not reachable by an
  anonymous attacker at all.
- **OTP guessing is bounded by the database, not by the throttle.** The
  attempt budget (5 per challenge, enforced by a conditional `UPDATE`) times
  the rolling request budget (5 per hour per number) caps an attacker at
  ≤25 guesses per number per hour against a 10⁶ keyspace — identical on
  either route. The per-IP limit on `otp/verify` is the outer layer, never
  the load-bearing one.

The residual is modest authenticated CPU amplification on the Google link
route. Giving both link routes the same overrides as their sign-in twins
would cost one decorator each; it is recorded as a follow-up rather than
changed here, because it is a rate-limit policy decision for authenticated
routes, not part of reconciling the client contract.

**Per-number and per-challenge (PostgreSQL, survives restart, applies across
every instance and every source IP)** — the load-bearing layer:

| Rule | Value |
|---|---|
| Resend cooldown | 60 s per phone number |
| Rolling request budget | 5 per hour per phone number |
| Attempt budget | 5 guesses per challenge |
| Code lifetime | 5 minutes |
| Live codes per number | exactly 1 (issuing a new one consumes the old) |
| Challenge retention | 24 h, then opportunistically pruned |

The attempt budget and the single-use claim are enforced by predicates in a
`WHERE` clause (`attemptCount < 5`, `consumedAt IS NULL`), never by a
read-then-write in application code — so concurrent guesses cannot exceed
the budget and two concurrent verifies of the same correct code produce
exactly one success.

**"At most one live code per number" is a DATABASE invariant, not an
application-level reconciliation.** `PhoneOtpChallenge.liveKey` equals the
phone number while a challenge is live and is `NULL` once it is consumed,
under a plain nullable `UNIQUE` index — the same mechanism, for the same
reason, as `PaymentOrder.openOrderKey`. A second live insert for one number
simply loses the index and is answered `429 OTP_RESEND_COOLDOWN`, atomically,
at any isolation level.

This replaced an earlier "insert, then re-read and decide who won" scheme.
Under `READ COMMITTED` a caller's `SELECT` cannot see a concurrent insert
that has not yet committed, so two callers could each conclude they had won,
and their follow-up "retire the other challenge" writes then crossed —
leaving a number with the *older* code live, or with **no** live code at all
despite messages having been delivered. That is a repeatable denial of
WhatsApp sign-in for a targeted number, and it reproduced under real load. A
positive control in `whatsapp-otp.service.spec.ts` asserts the database
itself refuses the second live row, so the fix cannot quietly become vacuous.

A consequence worth stating: **a burst of concurrent requests sends exactly
one message**, not one per request. Issuance only releases the slot for a
challenge that has already outlived its cooldown, so racers cannot retire
each other's fresh claim.

**Accepted tradeoff:** because there is one live code per number, anyone who
knows a number can, once per cooldown, request a fresh code and thereby
retire an outstanding one. The replacement still goes to the same phone, so
this is a nuisance rather than a way in — and the alternative (several live
codes per number) would multiply the guessing surface.

---

## 6. Account collision and linking policy

**The rule: string equality is not proof of ownership.**

Given an existing email/password account `user@example.com`, and a Google
sign-in whose token carries a verified `email` of `user@example.com` and a
`sub` not yet known to this system:

```
POST /auth/google  ->  409 AUTH_ACCOUNT_LINK_REQUIRED
```

Nothing is created, nothing is linked, no session is issued. The supported
path proves **both** sides in one request:

```
POST /auth/login                      (proves control of the Short Drama account)
POST /auth/identities/google/link     (proves control of the Google account)
   Authorization: Bearer <accessToken>
   { "idToken": "..." }
```

Additional rules:

- An **unverified** provider email matches nothing. It neither collides with
  an existing account nor is recorded as the new account's email — the
  fail-closed direction in both cases.
- Linking an identity already bound to another account is **refused**, never
  transferred.
- Linking a second, different identity for a provider the account already has
  is refused.
- Re-linking the identity you already own is an **idempotent success**, not a
  409.
- Linking never writes `User.email` — that would silently create a
  password-reset surface as a side effect of a link.
- Unlinking never revokes sessions. `POST /auth/logout-all` is the tool for
  that.
- Phone numbers have **no** collision case: a number is never stored on
  `User`, so the only thing a normalized number can match is another
  `whatsapp` identity — which means the same person signing in again.

---

## 7. Configuration

| Variable | Required when | Notes |
|---|---|---|
| `GOOGLE_AUTH_ENABLED` | never | Exact string `"true"` to enable. Default off. |
| `GOOGLE_OAUTH_CLIENT_IDS` | `GOOGLE_AUTH_ENABLED=true` | Comma-separated `aud` allowlist. **Not a secret.** |
| `WHATSAPP_AUTH_ENABLED` | never | Exact string `"true"` to enable. Default off. |
| `WHATSAPP_OTP_PROVIDER_DRIVER` | `WHATSAPP_AUTH_ENABLED=true` | Only `fake` is implemented, and only in `development`/`test`. |

**No Google client secret exists anywhere in this codebase.** Verifying an ID
token needs only Google's public signing keys plus the client id (itself
public — it ships in the app binary). The client secret belongs to the
authorization-code exchange, which happens on the client in this
architecture. A secret that is never held cannot be leaked.

### 7.1 Which client IDs belong in `GOOGLE_OAUTH_CLIENT_IDS`

`GOOGLE_OAUTH_CLIENT_IDS` is the allowlist this server matches an incoming ID
token's **`aud` claim** against. `aud` is the client id that Google issued the
token TO — so the allowlist must contain every client id any shipping app
build can cause Google to mint a token for, and nothing else.

The mobile app configures Google Sign-In with these environment keys
(the two client IDs are read by `google-sign-in-contract.ts`; the URL scheme
is consumed by `app.config.js` at build time, not by any runtime code):

| Mobile env key | Google credential type | Goes in `GOOGLE_OAUTH_CLIENT_IDS`? |
|---|---|---|
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | **Web application** | **YES — always. This is the one that matters.** |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | iOS | **YES** if any iOS build ships |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | *(not a client id)* | **NO** — the reversed-iOS-client-id URL scheme the native SDK needs to receive the OAuth callback. Read by `app.config.js` before `expo prebuild`, never at runtime, and it has no meaning to this server |
| *(none — Android has no `EXPO_PUBLIC_*` key)* | Android | **YES** if any Android build ships |

**Why the WEB client id is the load-bearing one, on every platform.** The
mobile adapter calls `GoogleSignin.configure({ webClientId, iosClientId? })`
(`services/auth/google-sign-in.ts`), and `webClientId` is what makes Google
mint an **ID token for the backend** rather than only a platform access
token. On both Android and iOS the resulting token's `aud` is therefore the
**web** client id. The mobile side already treats a missing ID token as
"check that the web client ID matches this project" for the same reason. A
backend allowlist containing only the Android and iOS ids would reject
every real token with `401 INVALID_GOOGLE_TOKEN` while everything looked
correctly configured on both sides — the single most likely misconfiguration
of this whole feature, recorded here so it is diagnosed in minutes.

**Why the Android/iOS ids are still listed.** They cost nothing to include,
they cover any SDK version or flow that mints a token audienced to the
platform client instead, and Android's client id is bound to a specific
package name + SHA-1 signing certificate, so listing it does not widen the
allowlist to arbitrary callers. Note that Android's client id never appears
in the app's own environment — it is registered in Google Cloud Console and
resolved by Play Services from the package/signature — so it must be copied
from the console, not from `.env`.

Format (comma-separated, no spaces), exactly as `.env.example` shows:

```
GOOGLE_OAUTH_CLIENT_IDS=<android>.apps.googleusercontent.com,<ios>.apps.googleusercontent.com,<web>.apps.googleusercontent.com
```

**Every value above is a public identifier, not a secret**, and none is
committed to either repository: the backend reads them from the environment
and the app inlines its own at build time. All must come from the SAME Google
Cloud project — ids from two projects will verify signature and issuer and
then fail the audience check.

**No live Google credential has been exercised by this repository.** ID-token
verification is proven against generated RSA keys and controlled fixtures
(`google-oidc.verifier.spec.ts`), and the e2e suite substitutes the verifier
at its DI seam. Turning this on for real is a configuration + QA step, not a
code change.

**WhatsApp cannot currently be enabled in production.** With
`WHATSAPP_AUTH_ENABLED=true` and any driver other than `fake`, the process
refuses to boot; with `fake` and a `NODE_ENV` other than
`development`/`test`, it also refuses to boot. No vendor client ships,
because no vendor credentials exist to build or test one against. See §8.

---

## 8. What is NOT done

Stated plainly so nothing here is mistaken for more than it is:

- **No real WhatsApp message has ever been sent by this code.** The only
  implemented provider delivers nothing.
- **No real Google credential has been exercised.** Verification is proven
  against generated RSA keys and controlled fixtures, not against a live
  Google token.
- **A social-only account cannot self-delete** (`POST /users/me/deletion`
  requires re-proving a password it does not have) and **cannot set a first
  password** (password reset is deliberately refused for it). Both are
  credential-adding/irreversible flows that need their own review.
- **Registration still does not verify email ownership**, and this backend
  ships no email delivery at all. Consequence, found by the Phase 10B
  identity security review and accepted rather than silently carried: someone
  can register `victim@example.com` without owning it, and the real owner of
  that Google account is then refused at §6's boundary with
  `AUTH_ACCOUNT_LINK_REQUIRED` and told to use a password they never set.
  This is squatting/availability, **not** takeover — the squatter gains
  nothing the victim controls. The refusal is still correct: narrowing the
  collision check to "only collide when the existing email is verified"
  would, with no email verification anywhere in this system, disable the
  boundary entirely. The real fix is email-ownership verification at
  registration, which is a separate work unit gated on an email-delivery
  capability.

---

## 9. Phase 10C reconciliation — decisions and what changed here

The backend and the mobile client built this surface in parallel. Every
disagreement is resolved below, once, with the reasoning recorded so it is
not relitigated.

### 9.1 The tie-breaker

The mobile paths and codes were a **proposal**, not a deployed contract: its
own module header and its `docs/api-contract.md` banner both say so, and
**no backend ever served those paths.** Every URL is built inside one client
module, so switching them is a one-file change. (Screens do call into that
module — `login-whatsapp.tsx`, `stores/auth.tsx` and the mounted
`LinkedMethodsCard` all do — they simply never construct a path themselves.)

The backend's routes are implemented, hardened, covered by unit + e2e tests,
and constrain a real database schema. So the rule applied throughout was:
**the canonical contract is the one that already exists and is tested,
unless it is actually wrong.** Exactly one mobile expectation was judged
genuinely better and adopted (§9.3).

**No compatibility aliases were added.** Two production paths for one action
means two things to secure, rate-limit, audit and keep in step forever. The
mobile routes were never deployed, so nothing depends on them and no
migration window is owed to anyone.

### 9.2 Canonical routes (backend's — unchanged)

| Action | **CANONICAL** | Mobile's provisional path (dropped) |
|---|---|---|
| Google sign-in | `POST /auth/google` | `POST /auth/providers/google` |
| WhatsApp start | `POST /auth/whatsapp/otp/request` | `POST /auth/providers/whatsapp/start` |
| WhatsApp verify | `POST /auth/whatsapp/otp/verify` | `POST /auth/providers/whatsapp/verify` |
| List methods | `GET /auth/identities` | `GET /auth/methods` |
| Unlink | `DELETE /auth/identities/:provider` | `DELETE /auth/methods/:provider` |
| Link Google | `POST /auth/identities/google/link` | *(mobile had none)* |
| Link WhatsApp | `POST /auth/identities/whatsapp/link` | *(mobile had none)* |

Against the stated preference order:

- **Provider-neutral.** The part that must be provider-neutral is the
  MANAGEMENT surface, and it already is: one resource (`/auth/identities`),
  one listing shape, one `:provider` segment. The sign-in routes are
  deliberately per-provider because their credentials are genuinely
  different types — `{ idToken }` versus `{ phone, code }`. Collapsing them
  behind `POST /auth/providers/:provider` would mean one endpoint with a
  polymorphic body, one throttle bucket for two very differently-abusable
  operations, and validation that can no longer be a DTO.
- **Extensible.** Adding Apple is `POST /auth/apple` plus
  `POST /auth/identities/apple/link`, and it appears in the existing listing
  automatically. Nothing about `/auth/providers/*` extends better.
- **REST-consistent.** `/auth/identities` is the resource; `/auth/google` is
  an action alongside `/auth/login`, `/auth/refresh`, `/auth/logout`.
  Introducing `/auth/providers/*` would create a SECOND provider namespace
  beside `/auth/identities/*` — strictly worse.
- **Least disruptive to existing public routes.** Decisive: the backend
  routes exist, are tested, and are what `/auth/*` already looks like.

### 9.3 The one change made to the backend

`POST /auth/whatsapp/otp/request` now also returns
**`resendAvailableInSeconds`** (§3.3). The mobile client was right that a
client must not infer resend timing: it had already been bitten by a
countdown computed from a missing field, which produced `NaN`, never reached
zero, and left the resend button permanently disabled. The value is the fixed
`OTP_RESEND_COOLDOWN_MS`, so it leaks nothing (§3.3), and it is now asserted
in both the unit and e2e suites.

It is the per-number **cooldown**, which is a MINIMUM wait — the per-IP
throttle and the rolling per-hour budget can both extend the real wait, so
`429` handling on resend stays mandatory. See the callout in §3.3; that
caveat is part of the frozen contract, not a footnote.

`challengeId` was **not** added — see §3.3 for why the phone number is the
handle and why a second key for one row would weaken the single-live-challenge
invariant.

### 9.4 Error-code vocabulary — canonical names win

| Mobile expected | **CANONICAL** | Why |
|---|---|---|
| `INVALID_PROVIDER_TOKEN` | `INVALID_GOOGLE_TOKEN` | Same meaning; the backend name is the one in the enum, the audit trail and the tests. A rename buys nothing. |
| `PROVIDER_ACCOUNT_CONFLICT` | `AUTH_ACCOUNT_LINK_REQUIRED` | The backend name states the RESOLUTION ("link it"), not just that something clashed — and there is a specific supported flow to point the user at (§6). |
| `LAST_AUTH_METHOD` | `AUTH_LAST_IDENTITY` | Same meaning; matches the `AUTH_*` family every other code in this area uses. |
| `OTP_INVALID` / `OTP_EXPIRED` / `OTP_TOO_MANY_ATTEMPTS` | **`INVALID_OTP` — single code, deliberately** | See below. |

**The OTP three-way split is REFUSED, and this is the one place the mobile UX
loses something real.** Distinguishing "expired" from "attempts exhausted"
tells an attacker whether their guessing is making progress; distinguishing
"wrong code" from "no challenge for this number" turns the verify endpoint
into a **phone-number enumeration oracle**, which is precisely what the whole
`202`-always start contract exists to prevent. The client cannot be handed a
distinction the server must not reveal. The specific cause IS recorded, in
`AuthAuditEvent`, where it helps an operator and not an attacker.

Consequence for mobile, stated plainly: the three distinct strings collapse
into one message that must cover all causes without implying which — along
the lines of *"Kode salah atau sudah kedaluwarsa. Minta kode baru."* The 429
resend/cooldown case stays separate, because that one is answered by a
genuinely different code (`OTP_RESEND_COOLDOWN`) on a different route.

### 9.5 Unlink returns `200` + the updated list, not `204`

Mobile expected `204 No Content`. The canonical response is `200` with the
caller's full, updated identity list. After removing a sign-in method the
very next thing a UI must know is what remains and what is still removable;
`204` forces an immediate second request and leaves a window where the
client's `canBeUnlinked` flags are stale. The client should replace its list
with the response body rather than mutating its own copy.

### 9.6 Confirmed already-agreeing (no action)

Email register/login paths and bodies; `AuthResponse` envelope; refresh
rotation and reuse detection; `INVALID_CREDENTIALS`, `EMAIL_ALREADY_REGISTERED`,
`INVALID_ACCESS_TOKEN`, `INVALID_REFRESH_TOKEN`, `INVALID_PHONE_NUMBER`;
"login never registers"; the anti-enumeration requirement on OTP start; the
one-shot treatment of the Google ID token; and that the backend — not
`canUnlinkAuthMethod` — is the authority on the last-method rule.

---

## 10. Mobile reconciliation list (`mobile-app-ecc` @ `9a1d1ae`)

Mechanical edits, derived from §9. **The mobile worktree was NOT modified by
this work unit** — this is the specification for the next mobile slice.
Nearly all of it lands in one file, which is what
`provider-auth-service.ts`'s single-module discipline was for.

### `src/services/auth/provider-auth-service.ts`

| Current | Change to |
|---|---|
| `POST auth/providers/google` | `POST auth/google` |
| `POST auth/providers/whatsapp/start`, body `{ phoneNumber }` | `POST auth/whatsapp/otp/request`, body **`{ phone }`** |
| `POST auth/providers/whatsapp/verify`, body `{ challengeId, code }` | `POST auth/whatsapp/otp/verify`, body **`{ phone, code }`** |
| `GET auth/methods` | `GET auth/identities` |
| `DELETE auth/methods/:provider` → `void` | `DELETE auth/identities/:provider` → **returns the updated identity list**; use it |
| *(no link functions)* | add `linkGoogle(idToken)` → `POST auth/identities/google/link`, and `linkWhatsApp(phone, code)` → `POST auth/identities/whatsapp/link`, both `{ requiresAuth: true }`, both returning the updated list |
| `parseOtpChallenge` requires `challengeId` | drop `challengeId`; keep the finite-number checks on `expiresInSeconds` and `resendAvailableInSeconds` — the server now always sends both, and validating them at the boundary is still right |
| doc'd codes `INVALID_PROVIDER_TOKEN` / `PROVIDER_ACCOUNT_CONFLICT` / `LAST_AUTH_METHOD` | `INVALID_GOOGLE_TOKEN` / `AUTH_ACCOUNT_LINK_REQUIRED` / `AUTH_LAST_IDENTITY` |

**Full error set per function** — the renames above are not the whole story,
and the link/unlink routes in particular return codes the mobile surface has
never had to handle. Every one of these needs its own message; collapsing
them into a generic "gagal" turns a precise, correct refusal into an
unexplained dead end:

| Function | Codes it must handle |
|---|---|
| `loginWithGoogleIdToken` | `INVALID_GOOGLE_TOKEN` 401 · `AUTH_ACCOUNT_LINK_REQUIRED` 409 · `GOOGLE_AUTH_DISABLED` 503 |
| `startWhatsAppOtp` | `INVALID_PHONE_NUMBER` 400 · `OTP_RESEND_COOLDOWN` 429 · generic `HTTP_ERROR` 429 from the per-IP throttle · `WHATSAPP_AUTH_DISABLED` 503 |
| `verifyWhatsAppOtp` | `INVALID_OTP` 401 · `INVALID_PHONE_NUMBER` 400 · generic `HTTP_ERROR` 429 (per-IP verify throttle) · `WHATSAPP_AUTH_DISABLED` 503 |
| `linkGoogle` | `INVALID_GOOGLE_TOKEN` 401 · **`AUTH_IDENTITY_ALREADY_LINKED` 409** · `AUTH_PROVIDER_ALREADY_LINKED` 409 · `GOOGLE_AUTH_DISABLED` 503 |
| `linkWhatsApp` | `INVALID_OTP` 401 · `INVALID_PHONE_NUMBER` 400 · **`AUTH_IDENTITY_ALREADY_LINKED` 409** · `AUTH_PROVIDER_ALREADY_LINKED` 409 · `WHATSAPP_AUTH_DISABLED` 503 |
| `unlinkAuthMethod` | `AUTH_LAST_IDENTITY` 409 · `AUTH_IDENTITY_NOT_FOUND` 404 · `HTTP_ERROR` 400 for an unroutable `:provider` (e.g. `email`) |

`AUTH_IDENTITY_ALREADY_LINKED` is the security-relevant one: it means *"that
Google account / phone number already belongs to a different Short Drama
account."* That is a refusal a person can act on, and it must say so.

### `src/types/auth.ts`

| Current | Change to |
|---|---|
| `AuthUser.email: string` | **`email: string \| null`** (§3.5). `deriveAuthUser`'s existing defensive `typeof === 'string'` guard already behaves correctly; this makes the type tell the truth instead of the guard carrying it alone. |
| `OtpChallenge = { challengeId, expiresInSeconds, resendAvailableInSeconds }` | `{ expiresInSeconds, resendAvailableInSeconds }` — the phone number the screen already holds is the handle |
| `LinkedAuthMethod = { provider, label, linkedAt }` | mirror `AuthIdentitySummaryDto`: `{ provider, identifier, usable, canBeUnlinked, createdAt, verifiedAt }` (rename `label`→`identifier`, `linkedAt`→`createdAt`) |

### `src/app/login-whatsapp.tsx`

- Verify with the number, not a challenge id: `loginWithWhatsApp(phoneE164, code)`.
- `describeVerifyError`: replace the `OTP_INVALID` / `OTP_EXPIRED` /
  `OTP_TOO_MANY_ATTEMPTS` switch with a single `INVALID_OTP` branch and one
  message covering all causes (§9.4). **Keep the `429` branch**, but for the
  right reason: `describeVerifyError` only ever sees errors from the VERIFY
  call, so a `429` there is the per-IP **verify** throttle (5/min, surfacing
  as `code: "HTTP_ERROR"`) — a genuinely different condition from
  `INVALID_OTP`, and the only handling it has. The resend cooldown is a
  separate `429` on the START route, already handled in `requestCode`. The
  branch is not dead; do not delete it when the switch above collapses.
- Everything else stands: the two-step layout, the anti-enumeration
  behaviour, and re-locking the countdown from the server's value on a 429.

### `src/stores/auth.tsx`

- `loginWithWhatsApp(challengeId, code)` → `loginWithWhatsApp(phoneE164, code)`.
- **`deriveAuthUser` and the store's OWN `AuthUser` type must change too.**
  `stores/auth.tsx` declares a second, local `AuthUser` with
  `readonly email: string` and coerces a missing address to `''`, then
  derives `username` from that empty string and falls back to
  `name: backendUser.id`. That guard was the right defensive move when the
  backend contract was unknown, but under the canonical contract it now
  produces the exact outcome §3.5 exists to prevent: a phone-only account
  whose profile screen renders a blank email line and a raw cuid as the
  display name. Widen the local `email` to `string | null`, stop coercing to
  `''`, and give the profile screen a real fallback — the MASKED
  `identifier` from `GET /auth/identities`, or omit the row entirely. Do not
  substitute the id.
- Token persistence and the Google path are otherwise unchanged beyond the
  URL moving inside `provider-auth-service.ts`.
- **One challenge, two consumers — do not cross them.**
  `verifyWhatsAppOtp` and `linkWhatsApp` consume the SAME challenge for a
  number; nothing binds a challenge to an intent. Calling `verify` during a
  link flow does not extend the current account, it REPLACES the current
  session with the phone's own account. Neither is a security hole (both
  require controlling the phone, and linking a number owned elsewhere fails
  closed with `AUTH_IDENTITY_ALREADY_LINKED`), but the two call sites must
  not be interchanged by mistake.

### `src/features/auth/linked-methods.ts` and `linked-methods-card.tsx`

- Prefer the server's `canBeUnlinked` over recomputing it. Keep
  `canUnlinkAuthMethod` as the local fallback and keep dropping unknown
  providers, but the server flag is authoritative when present — it is
  computed by the same rule `DELETE` enforces, so the two can never disagree.
- The card can now surface `usable`. Note what that flag would mean: an
  `email` identity on an account with no password — a state **no current
  path produces** (`register` always sets a hash, and the accounts created
  with `passwordHash: null` get no `email` identity row). Render it
  defensively; do not present it as a state users will encounter.
- The unlink handler should adopt the returned list rather than re-fetching.
- **REQUIRED, not optional: add a LINK control for each unlinked provider**,
  wired to `linkGoogle` / `linkWhatsApp`. The card currently renders unlink
  controls only. This is the one recovery path §6 exists to offer — see the
  next bullet for why it cannot be deferred.
- **`AUTH_ACCOUNT_LINK_REQUIRED` must point at that control.** When Google
  sign-in hits the collision boundary the server returns, verbatim: *"An
  account already exists for this email address. Sign in with your existing
  method, then link this provider from your account settings."* If the app
  has no link affordance, it is instructing people to do something it does
  not let them do. That is not merely poor UX — an unreachable escape hatch
  is precisely how a correct security boundary gets relitigated: the next
  bug report reads "Google login is broken", and the tempting fix is to
  weaken §6's collision check. Ship the control with the error message.

### Mobile tests that move with the contract

Four suites assert the provisional shapes and will fail until they are
updated alongside the source above — they are part of the slice, not
fallout: `services/auth/__tests__/provider-auth-service.test.ts` (paths,
bodies, the `challengeId` payload validation), `app/__tests__/login-whatsapp.test.tsx`
(the challenge fixture and the three OTP error messages),
`stores/__tests__/auth.test.tsx` (the `loginWithWhatsApp` signature), and
`features/auth/__tests__/linked-methods-card.test.tsx` (the
`LinkedAuthMethod` shape).

### `docs/api-contract.md` (mobile)

Replace the "Provider auth (Phase 10B)" section wholesale: drop the
PROVISIONAL banner, use the canonical paths/bodies/codes above, document
`user.email` as nullable, and document the two link routes it never had.

### Explicitly NOT required of mobile

No new screens, no change to the register/login screens' own flow, and no
change to the Google native adapter — `google-sign-in.ts` already produces
exactly the one credential the canonical contract wants (§3.2), and
`resolveGoogleConfig`'s env keys are unchanged (§7.1).

**Two exceptions, both listed above and both required:** the link control on
`LinkedMethodsCard` (the `AUTH_ACCOUNT_LINK_REQUIRED` recovery path), and the
profile screen's fallback when `user.email` is `null`. Everything else on
this list is mechanical.

### Not available to mobile, and must not be built as if it were

- **A "set first password" flow** for a Google-only/WhatsApp-only account.
  Password reset deliberately refuses these accounts (§8) rather than
  silently minting a first credential. Mobile must not present password
  reset as a route into a passwordless account.
- **Self-delete for a passwordless account.** `POST /users/me/deletion`
  requires the current password and therefore fails closed with
  `INVALID_CREDENTIALS` for an account that has none (§8). The Data &
  Privacy screen should not offer deletion as if it will work for such an
  account; the honest resolution needs a verified-provider
  reauthentication flow, which does not exist.
- **WhatsApp login in production.** The API contract is complete and tested,
  but no vendor delivery adapter exists and the process refuses to boot with
  WhatsApp enabled outside development/test (§7, §8). Ship the UI behind the
  same server-driven gate that already answers `503 WHATSAPP_AUTH_DISABLED`.
