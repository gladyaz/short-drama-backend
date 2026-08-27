# Account deletion — Red Panda V1

**Status:** every V1 sign-in method has a working self-service deletion path.
**Scope:** this backend. The public website and the mobile app are described
only where their contract with this backend matters.

---

## 1. The defect this document replaces

`POST /users/me/deletion` shipped in Phase 12 requiring two things: an
explicit `confirmDeletion: true`, and the account's **current password**. It
refused outright when `User.passwordHash` was `null`.

Nothing was wrong with that on the day it shipped — every account had a
password. Then Phase 10B made `passwordHash` nullable and added Google and
WhatsApp sign-in, and the V1 feature contract made **both of those
mandatory**. From that point:

- a **Google-only** account had no password, so deletion answered
  `401 INVALID_CREDENTIALS` — telling the owner their password was wrong for
  an account that never had one;
- a **WhatsApp-only** account was in exactly the same position;
- both are created by the two sign-in methods the V1 store listing leads
  with.

The product could create accounts it could not delete, and every automated
signal stayed green. It was found by a human reading the public website's
privacy page.

---

## 2. The rule now

> **Deletion proof is appropriate to the identity, and is always a fresh
> re-demonstration of the same factor the account signs in with.**

| Account has | Proof method | What is verified |
|---|---|---|
| `passwordHash` | `password` | bcrypt against the stored hash |
| a `google` identity | `google` | a freshly obtained Google ID token, verified server-side, whose `sub` equals **this account's** `AuthIdentity.providerSubject` |
| a `whatsapp` identity | `whatsapp` | a single-use OTP delivered to **this account's** linked number, in the `account_deletion` challenge namespace |

**Nothing about authentication was weakened.** A valid access token is still
necessary and still not sufficient. `confirmDeletion: true` is still required
and is still an intent flag, never a credential. A password account behaves
exactly as before.

### Multi-identity accounts: any one proof suffices

An account may hold a password *and* Google *and* WhatsApp. **Any single
method it owns authorizes deletion.**

This is deliberate, and it is not a weakening: each linked method is already
independently sufficient to *sign in* and take complete control of the
account, including changing the password and unlinking the others. Requiring
all of them would mean a user who has lost access to any one factor could
never delete their account — the exact failure this work repairs, reintroduced
in a new place. `GET /users/me/deletion/methods` returns every method the
account can use; the client picks one.

### Where the policy lives

- `src/auth/deletion/deletion-authorization.types.ts` — the design and the
  provider → proof map.
- `src/auth/deletion/deletion-authorization.service.ts` — the gate.
- `src/auth/auth.service.ts` (`deleteAccount`) — the transaction, unchanged.

There is **no stored deletion token**. All three proofs are verifiable inside
the deletion request itself, and the WhatsApp challenge already provides the
short-lived, single-use, attempt-bounded, account-bound properties such a
token would have been built to provide. Adding a second credential store to
restate them would be new persistence for no gain.

---

## 3. API contract

All routes require `Authorization: Bearer <accessToken>`.

| Method | Path | Success | Purpose |
|---|---|---|---|
| GET | `/users/me/deletion/methods` | `200` | Which proofs this account can use |
| POST | `/users/me/deletion/whatsapp/otp` | `202` | Send a deletion code to the account's own linked number |
| POST | `/users/me/deletion` | `200` | Delete, given a valid proof |

### `GET /users/me/deletion/methods`

```json
{ "methods": ["password", "google", "whatsapp"] }
```

Ordered `password`, `google`, `whatsapp`. A method appears only when the
account owns the credential **and** this server can verify it (the provider's
feature flag is on). Returns **only method names** — no email, no phone, no
`sub`. Clients that need a display identifier read the masked one from
`GET /auth/identities`.

An **empty list is a truthful answer**, not an error: a Google-only account on
a server with `GOOGLE_AUTH_ENABLED=false` genuinely has no verifiable proof.
The release gate refuses to certify a release in that posture (§6).

### `POST /users/me/deletion/whatsapp/otp`

Empty body. The number is read from the caller's own linked identity — **there
is no `phone` field and no way to supply one**, which is what keeps this
authenticated route from becoming a way to send messages to arbitrary numbers.

```json
{ "success": true, "expiresInSeconds": 300, "resendAvailableInSeconds": 60 }
```

Errors: `409 ACCOUNT_DELETION_METHOD_UNAVAILABLE` (no linked number, or
WhatsApp disabled), `429 OTP_RESEND_COOLDOWN`,
`503 WHATSAPP_PROVIDER_UNAVAILABLE`. The per-IP route throttle is the same
3-per-10-minutes budget `POST /auth/whatsapp/otp/request` carries and its
`429` comes from the framework, so it reports `code: "HTTP_ERROR"` — branch on
**status**, not code.

### `POST /users/me/deletion`

```jsonc
// password — the pre-existing body, still valid verbatim
{ "currentPassword": "…", "confirmDeletion": true }

// password — explicit form, identical behaviour
{ "method": "password", "currentPassword": "…", "confirmDeletion": true }

// google
{ "method": "google", "idToken": "<fresh Google ID token>", "confirmDeletion": true }

// whatsapp
{ "method": "whatsapp", "code": "123456", "confirmDeletion": true }
```

`method` is optional and defaults to `"password"`, so **every existing client
keeps working with no change**. Proof fields belonging to other methods are
ignored, never used as proof.

Response: `200 { "success": true }`.

| Status | Code | Means |
|---|---|---|
| `400` | `HTTP_ERROR` | Missing/`false` `confirmDeletion`, unknown `method`, missing the field the chosen method needs |
| `401` | `INVALID_ACCESS_TOKEN` | No/expired token, or the account no longer exists (a repeat call) |
| `401` | `INVALID_CREDENTIALS` | Wrong password |
| `401` | `INVALID_GOOGLE_TOKEN` | The Google credential did not verify |
| `401` | `INVALID_OTP` | Code wrong, expired, exhausted, or already used |
| `401` | `ACCOUNT_DELETION_PROOF_MISMATCH` | The credential verified but belongs to a different identity |
| `403` | `ACCOUNT_DELETION_FORBIDDEN` | Not a normal `user` role |
| `409` | `ACCOUNT_DELETION_METHOD_UNAVAILABLE` | This account cannot produce the named proof |
| `429` | `HTTP_ERROR` | 5 deletion attempts per 15 minutes, per IP |

---

## 4. What deletion does

Unchanged from Phase 12, except for one added step. In **one transaction**,
after the `User` row lock:

1. every `Session` for the account is revoked;
2. the account's own `AuthAuditEvent` rows are scrubbed — `userId`, `ipHash`,
   `userAgent` and `metadata` nulled, only `event` and `createdAt` kept
   (**before** the delete, because `onDelete: SetNull` fires inside the same
   transaction);
3. the `User` row is deleted.

**Cascade-deleted** (`onDelete: Cascade`, so removed outright): `Session`,
`AuthIdentity`, `UserVideoInteraction`, `WatchProgress`, `Entitlement`,
`PasswordResetToken`, `AccountLockout`, `RewardWallet`, `RewardLedgerEntry`,
`RewardCheckIn`, `RewardRedemption`, `RewardMissionClaim`,
`RewardWatchCredit`, `RewardPerk`.

**Survive, de-linked** (`onDelete: SetNull`): `AnalyticsEvent` (has no
IP/user-agent column at all) and `AuthAuditEvent` (scrubbed explicitly in step
2 — the cascade alone would only null the FK). `PaymentOrder` is also
`SetNull`; V1 ships no payment flow, so V1 accounts have none.

**Purged after the commit** (added by this work unit): every
`PhoneOtpChallenge` for the account's number. That table deliberately has no
`userId` and no foreign key — an OTP is requested for a *number*, before the
server may know whether an account exists — so no cascade reaches it. The
purge is a single auto-commit `deleteMany` run **outside** the transaction,
because `PhoneOtpChallenge` is deliberately kept out of every multi-statement
transaction (see the CANONICAL AUTH LOCK ORDER block in `auth.service.ts`).

### No way back in

`AuthIdentity` cascades. After deletion the Google `sub` and the phone number
resolve to nothing, so presenting either again takes the brand-new-account
path and creates a **fresh, empty** account. There is no orphan identity that
can re-enter a deleted account. Asserted in
`test/account-deletion-providers.e2e-spec.ts`.

### Sessions

All `Session` rows are removed, so **every refresh token is dead
immediately**. Access tokens are stateless JWTs and are not individually
revocable — but every authenticated route resolves the account and answers
`401 INVALID_ACCESS_TOKEN` once it is gone, so an unexpired access token
grants nothing. Both halves are asserted end-to-end.

---

## 5. The WhatsApp deletion challenge

It reuses the **existing production OTP architecture** — the same
`WhatsAppOtpService`, the same `PhoneOtpChallenge` table, the same Cloud API
driver. There is no second OTP system.

The one addition is `PhoneOtpChallenge.purpose` (`login` | `account_deletion`,
default `login`):

- `claimChallenge` filters by it, so **a deletion code can never be redeemed
  at `POST /auth/whatsapp/otp/verify`** to mint a session or create an
  account. This is the security property, not a nicety.
- `hashOtpCode` mixes a per-purpose domain tag into the HMAC, so the two hash
  spaces cannot overlap even if a query forgot the filter. `login` maps to the
  empty tag, keeping its hash input byte-identical so no in-flight code is
  invalidated by the deploy.
- `liveKey` is now `"<purpose>:<phoneE164>"`, so the two flows cannot consume
  each other's live codes.

**Per-number limits remain shared and purpose-independent** — the 60-second
resend cooldown and the 5-per-hour rolling budget count *every* challenge for
the number. A message costs its recipient the same whatever it was for, and
those bounds are what protect a real handset. A deletion code requested
seconds after a login code therefore waits out the same cooldown, by design.

---

## 6. Release gate

`npm run release:gate` runs a step, **`deletion-coverage`**, that blocks on:

1. **Structural** — every provider in `AUTH_PROVIDERS` maps to an implemented
   `DeletionProofMethod`. `DELETION_PROOF_METHOD_BY_PROVIDER` is a total
   `Record<AuthProvider, DeletionProofMethod>`, so adding a fourth sign-in
   provider without deciding how its accounts delete themselves **fails to
   compile**; the gate restates it in the release report so an operator can
   read it.
2. **Environmental** — every V1-required login provider is actually enabled,
   because a provider this server cannot verify is a provider whose accounts
   have no deletion path. `GOOGLE_AUTH_ENABLED=false` is already blocked as a
   dead login button; this states the second, worse consequence.

Rules: `src/common/release-gate/v1-account-deletion-coverage.ts`.

---

## 7. The public website

**There is no unauthenticated web deletion API, and V1 does not add one.**

### The V1 strategy

**Primary: the authenticated in-app flow, for all three identity types.** This
is now genuinely available to every V1 account, which is what changed. The
public `/delete-account` page's job is to *explain* that route and what
deletion removes — which is what Google Play's account-deletion requirement
asks for. It does not require a web form.

**Fallback: verified, support-assisted request**, for someone who has lost
access to their sign-in factor entirely (lost phone, lost Google account).
Handled by a person, over email, after satisfying themselves the request comes
from the account holder. This path is unchanged and is now the exception
rather than the rule.

### Why not a web deletion endpoint

- **An unauthenticated route that deletes accounts is not something to ship
  under time pressure.** Identity must be proven on the web with the same
  strength as in the app, and getting that wrong destroys data irreversibly.
- **The WhatsApp half would be actively dangerous.** A public,
  unauthenticated "send a deletion code to this number" endpoint is both an
  SMS-bombing surface and an account-destruction surface aimed at anyone whose
  number an attacker knows. The in-app route avoids this entirely by never
  taking the number from the request.
- **The Google half is feasible but incomplete.** A web client id could be
  added to `GOOGLE_OAUTH_CLIENT_IDS` and an ID token accepted from the site.
  That would cover Google-only accounts and no one else, creating a second
  deletion path with different security properties for one of three identity
  types. Post-V1, if wanted, as a considered piece of work.

### The website copy needs updating

`red-panda-website/src/app/delete-account/page.tsx` currently leads with a
section stating that Google and WhatsApp accounts **cannot** use the in-app
route and must email support. **That is no longer true.** Its in-app steps
also describe entering a password as the only confirmation.

That repository was read-only in this work unit and was not modified. Required
changes, for whoever picks it up:

1. Demote or remove the "If you signed in with Google or WhatsApp" section —
   those accounts now delete in-app.
2. Rewrite the in-app steps so the confirmation step is *the method your
   account uses*: your password, re-confirming with Google, or a code sent to
   your WhatsApp number.
3. Keep the support route, reframed as the fallback for lost access to a
   sign-in method.
4. Keep "there is no self-service web form" — it remains true.

The "what deletion removes" and "what is kept" sections remain accurate.
