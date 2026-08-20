# Auth Identity API Contract — Phase 10B (Production Identity Providers)

**Status: implemented and tested on `feat/auth-production-identities`.** This
document is the authoritative contract for every authentication route this
backend exposes after Phase 10B, covering all THREE supported methods:

1. **Email + password** — unchanged, still primary, still always available.
2. **Google OAuth / OIDC** — new, flag-gated, off by default.
3. **WhatsApp OTP** — new, flag-gated, off by default.

All three resolve to the **same internal `User`** and issue the **same
`accessToken` / `refreshToken` / `Session`**. There is no such thing as a
"social session" in this system.

Nothing here is aspirational: every route, field, status and error code below
exists in the repository today and is covered by tests.

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
{ "success": true, "expiresInSeconds": 300 }
```

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

The raw `providerSubject` is **never** returned. A phone number is masked to
its last four digits. `canBeUnlinked` is computed server-side by the same
rule `DELETE` enforces, so a client rendering the button off this flag and
the server can never disagree.

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
