# Rewards API Contract

Canonical contract for the `/rewards/*` surface: the points wallet, the daily
check-in, the transaction ledger, and redemption into premium.

Added by the work unit **"REWARDS BACKEND FOUNDATION"**. It is the backend
half of the model proposed in the mobile repository's
`docs/rewards-domain-contract.md`, which was written while the Rewards Center
UI was built so the UI could be shaped around the right contract. That
document opens with **"Status: PROPOSAL. Nothing described here is
implemented."** — this one records what is now implemented, and, just as
importantly, what deliberately is not.

---

## 1. The one invariant

> A balance is a **projection of a ledger**, never a stored number that code
> is free to overwrite.

Everything else in this document follows from that sentence.

- **`RewardLedgerEntry` is the source of truth.** Append-only. No updates, no
  deletes. A correction is a new compensating entry, never an edit.
- **`RewardWallet.balancePoints` is a derived cache**, written by the same
  transaction that appends the entry. It is reconcilable at any time by
  summing the ledger — `GET /dev/rewards/reconcile` does exactly that. If the
  two ever disagree, **the ledger wins**.
- **The client never computes a balance.** It renders what the server sends.

The failure mode being designed out is `user.points = user.points + 50`. A
bare mutable counter cannot answer where points came from, whether a reward
was already paid, whether a retry double-paid, or how to reverse any of it.

**One writer.** `RewardsWalletService.appendEntry` is the only code in this
repository that moves a balance. Every route, including the dev-only demo
grant, goes through it.

---

## 2. Enabling the feature

| Variable            | Default        | Meaning                                                     |
| ------------------- | -------------- | ----------------------------------------------------------- |
| `REWARDS_ENABLED`   | `false`        | While false, **every** `/rewards/*` route answers `503 REWARDS_DISABLED` and no reward table is written. |
| `REWARDS_TIMEZONE`  | `Asia/Jakarta` | IANA zone whose **calendar day** defines a reward day.       |

`REWARDS_TIMEZONE` is validated at **boot**, whether or not the feature is
enabled: a value `Intl` cannot resolve fails startup rather than 500-ing on
the first check-in.

For the local Android demo, set `REWARDS_ENABLED=true` (and
`DEV_TOOLS_ENABLED=true` if you want the point-grant shortcut).

---

## 3. Routes

All routes require `Authorization: Bearer <accessToken>`. There is no
anonymous rewards surface: a wallet without an account has no owner, and an
anonymous streak has nothing to attach to. The user id always comes from the
verified token — never from a path or body parameter — so one account can
never act on another's balance.

| Method | Path                     | Purpose                                     |
| ------ | ------------------------ | ------------------------------------------- |
| `GET`  | `/rewards/snapshot`      | The whole Rewards Center in one read        |
| `POST` | `/rewards/check-in`      | Claim today's check-in                      |
| `GET`  | `/rewards/ledger`        | Paginated transaction history, newest first |
| `POST` | `/rewards/redemptions`   | Spend points on premium                     |
| `POST` | `/dev/rewards/grant`     | **Dev only.** Credit points for the demo    |
| `GET`  | `/dev/rewards/reconcile` | **Dev only.** Ledger-vs-projection check    |

The two `/dev/*` routes additionally require `DEV_TOOLS_ENABLED=true`, which
the app refuses to boot with outside `development`/`test`.

### 3.1 `GET /rewards/snapshot`

Returns `wallet`, `dailyCheckIn`, `watchTime`, `tasks` and `redemptions` in
one response. **One call, not four** — the balance, the streak strip and the
redemption availability must agree with each other, and four independent
requests can interleave with a check-in and render a balance that contradicts
the strip beside it.

It is a **pure read**: it creates no wallet row and no check-in row, so
polling it has no side effects.

### 3.2 `POST /rewards/check-in`

**Takes no body.** The date is the server's, the amount is the server's, and
the idempotency key is derived from the date — there is nothing for a client
to send and nothing it could send that would change the outcome.

Answers **200 in both cases**:

| Situation                    | `alreadyCheckedIn` | `awardedPoints` |
| ---------------------------- | ------------------ | --------------- |
| First check-in today         | `false`            | the day's value |
| Repeat / double-tap / retry  | `true`             | `0`             |

A repeat is a successful no-op, not a client error. Answering `409` would push
clients into rendering a normal double-tap as a failure.

### 3.3 `GET /rewards/ledger`

`?limit=` (1…100, default 20) and `?cursor=` (opaque, from the previous
page's `nextCursor`).

**Cursor, not offset.** An append-only table grows while a user pages through
it, and `skip`/`take` would shift entries between pages. Ordering is
`(createdAt desc, id desc)` so entries written in the same millisecond still
have a total order.

### 3.4 `POST /rewards/redemptions`

```json
{ "offerId": "redeem_vip_1d", "idempotencyKey": "<uuid>" }
```

**Note what is absent: no cost, no points, no duration.** The client sends
intent only; every economic value is resolved server-side from the catalog.
`ValidationPipe` runs app-wide with `forbidNonWhitelisted: true`, so a request
that invents a `costPoints` field is rejected outright rather than silently
ignored.

The debit, the receipt and the entitlement grant are **one transaction**.

---

## 4. Anti-abuse: what actually stops a double payout

### Idempotency is enforced by the database, not by a code path

`RewardLedgerEntry` carries `@@unique([userId, idempotencyKey])`.

**The key is server-derived for server-decided actions.** A daily check-in is
keyed `DAILY_CHECK_IN:<YYYY-MM-DD>`, composed from the server clock and the
service timezone. A client cannot vary it, so it cannot buy a second payout
for the same calendar day however it repeats the request.

**The key is client-supplied only where repeating is legitimate.** Redeeming
the same offer twice is a real thing to do, so only the client can distinguish
a retry from a second purchase. A key reused for a *different* offer is
refused (`REWARD_IDEMPOTENCY_KEY_REUSED`) rather than replayed — answering
offer B's request with offer A's receipt would report a purchase the caller
never made.

### Why a `SELECT` then `INSERT` is safe here

The mobile contract warns that a check-then-insert "races under concurrency
and will double-pay". That is true of an *unsynchronised* one. The race is
closed by the first statement of `appendEntry`: a `SELECT ... FOR UPDATE` row
lock on the owning `User`. Postgres admits at most one transaction past it per
user, so the duplicate lookup and the insert that follows are inside a
per-user critical section.

The unique constraint is the **backstop**, not the mechanism — if a future
writer reaches the table without taking the lock, the database refuses the
duplicate rather than paying twice.

**Why not rely on the constraint alone and catch `P2002`?** Because a failed
statement inside a Postgres transaction *aborts* it: every subsequent
statement fails with `25P02`. The loser could not read the winner's row to
replay it. This is pinned by a positive-control test
(`rewards-wallet.service.spec.ts` → "lock necessity"), which replays the
unlocked sequence and asserts one caller is rejected outright — so the
concurrency tests beside it cannot pass for the wrong reason.

### Lock order

`User` → `RewardWallet`, always. This extends the **canonical auth lock
order** documented above `AuthService` rather than inventing a second one — it
matters because redemption calls `EntitlementsService.grantTimedPremium` in
the same transaction, and `AuthService.deleteAccount` locks `User` and then
cascades into these very tables.

### The server owns "today"

Every date comes from the configured service timezone. Nothing reads a date,
a timezone, or a clock from the request. A device-derived boundary is
trivially farmed: move the phone clock forward, collect another check-in,
repeat.

Streak transitions are computed server-side: same date is a no-op, the
immediately-following date increments, **any gap resets**. A missed day is
never silently repaired.

### Database backstops

Application code refuses an overdrawing debit with a clean
`INSUFFICIENT_REWARD_POINTS`. Postgres `CHECK` constraints refuse it too
(`balancePoints >= 0`, `balanceAfter >= 0`, `deltaPoints <> 0`,
`costPoints > 0`, `grantsDays > 0`). These are last-resort guards: a rewards
system whose only defence against a free-money bug is "every caller remembers
to check" is one careless commit away from being a faucet.

---

## 5. Redemption and premium

The point debit and the entitlement grant are one atomic transaction — both
succeed or neither does. A failure anywhere rolls back every part: the user is
never charged for premium they did not get, and never given premium they did
not pay for.

Premium is granted through **the existing entitlement system**, via
`EntitlementsService.grantTimedPremium` — the same writer the payment flow
uses, differing only in the `source` string (`"reward-redemption"`). There is
deliberately **no second way to become premium**: "am I premium?" must not
depend on how you got there.

That method was extracted from the previous `grantPaidPremium` (which now
delegates to it, byte-identically) purely so it could be named for what it
does rather than for who called it first. **No payment code was modified and
no payment integration was added** — this work unit does not touch the
payments module.

Redemptions **stack**: buying a second day while one is running extends the
expiry rather than overwriting it.

---

## 6. What is deliberately NOT implemented

This is the most important section of this document. Three of the five task
types the mobile UI renders have **no server-verifiable completion signal**,
and this backend therefore refuses to pay any of them. `isClaimSupported` is
`false` on every task the snapshot serves, and there is **no task-claim
endpoint at all** — a route whose only behaviour is refusal is worse than no
route, because it implies one is coming.

| Task type       | Why it is not payable                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCIAL_FOLLOW` | Facebook, YouTube, TikTok and Instagram expose no "did user X follow page Y" check for arbitrary users. Opening a profile link proves a link was opened, nothing more — not that a follow happened, that it was the same person, or that it outlasted collecting the points. **This is a founder decision** (mobile contract §5, options 1–3), not an engineering one. |
| `REWARDED_AD`   | Must be credited only from the ad network's **server-side verification callback**, keyed on its transaction id. No such callback is wired in. Crediting a client "the ad finished" message is crediting an untrusted device. |
| `CAMPAIGN`      | Has no defined completion signal yet.                                                                                                                             |

**Why serve the tiles at all rather than an empty list?** Because the flags are
now *server-owned*. The day a verifiable signal exists, flipping
`isClaimSupported` in `rewards.constants.ts` makes every already-installed
client offer the claim with no mobile release. An empty list would push the
client back into deciding what exists.

**`watchTime` is always `null`.** This is an answer, not an omission. The
mobile contract requires watch-time credit to come from server-side watch
analytics. This backend's only watch data is `WatchProgress`, a per-series
**resume position** that *decreases* when a user rewatches an episode.
Summing it would not be watch time — it would be a number that looks like
watch time, which is precisely the failure the mobile `WatchTimeProgressSource`
union was designed to prevent by refusing to offer a `LOCAL_TIMER` member.
`null` renders the section's empty state honestly.

Also not built, and not needed by anything here: a `RewardClaim` table (the
one earn path is check-in, whose idempotency lives on the ledger key, and
redemption, which has its own receipt table), point expiry, streak repair, and
per-device anomaly detection.

---

## 7. Mapping to the mobile view model

The mobile `RewardsSnapshot` is served field-for-field, with two deliberate
differences — both in the same direction: **the server sends data, the client
owns presentation**.

| Mobile field                            | Source                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `wallet.balancePoints`                  | `wallet.balancePoints`                                          |
| `wallet.isServerAuthoritative`          | `wallet.isServerAuthoritative` — always `true` from this backend |
| `wallet.updatedAtLabel`                 | Client formats `wallet.updatedAt` (ISO-8601)                    |
| `dailyCheckIn.ctaLabel`                 | **Client**, via `t()`                                           |
| `dailyCheckIn.resetsAtLabel`            | **Client**, from `resetsAt` + `timezone`                         |
| `dailyCheckIn.days[].state`             | `dailyCheckIn.days[].state`                                     |
| `task.title` / `description` / `ctaLabel` | **Client**, via `t()`                                          |
| everything economic                     | **Server**                                                      |

The app ships three languages and localises through `t()`. A backend that sent
"Check in" would either force English on every locale or drag a translation
catalog into this service. It sends the facts; the client writes the copy.

`isServerAuthoritative` looks redundant coming from a server. It is sent
because the mobile fixture set hardcoded it `false` — a snapshot arriving with
it `true` is how the client distinguishes real state from the preview data it
used to render. Omitting the field would make the flag unfalsifiable rather
than unnecessary.

---

## 8. Economics, and what is still unapproved

Every number lives in `src/rewards/rewards.constants.ts` — the check-in curve
(`10, 15, 20, 25, 30, 40, 100` over a 7-day repeating cycle, day 7 the bonus)
and the redemption catalog (VIP 1d/1000pts, 3d/2500pts, 7d/5000pts disabled).

They are carried over verbatim from the mobile placeholder fixtures so the
local demo shows the figures it always did. **What changed is where they are
decided (server) and whether they are enforced (they now are).**

The values themselves remain **product-unapproved**. Still open, from the
mobile contract §8:

1. Daily check-in reward curve, cycle length, and whether a streak bonus exists.
2. Rewarded-ad reward value and daily cap.
3. Social-follow policy — the §6 decision above — and a reward value if any.
4. Watch-time milestone thresholds and values.
5. VIP redemption costs and benefit durations.
6. Point expiry: do points expire, and on what schedule.
7. Service timezone for the daily boundary (assumed `Asia/Jakarta`).
8. Whether points ever carry a stated monetary value.

Changing any of them is an edit to one file. Past ledger entries and
redemption receipts snapshot their values, so retuning the catalog never
rewrites history.

---

## 9. Error codes

| Code                            | Status | Meaning                                                    |
| ------------------------------- | ------ | ---------------------------------------------------------- |
| `REWARDS_DISABLED`              | 503    | `REWARDS_ENABLED` is off in this deployment                |
| `INSUFFICIENT_REWARD_POINTS`    | 409    | The debit would take the balance below zero                |
| `REWARD_OFFER_NOT_FOUND`        | 404    | No such offer in the catalog                               |
| `REWARD_OFFER_UNAVAILABLE`      | 409    | The offer exists but is not purchasable (`COMING_SOON`)    |
| `REWARD_IDEMPOTENCY_KEY_REUSED` | 409    | Key already used for a different offer                     |
| `REWARD_LEDGER_INVALID_DELTA`   | 400/500| Invalid dev-grant amount (400); zero/fractional delta (500)|
| `INVALID_ACCESS_TOKEN`          | 401    | Missing, malformed or expired credential                   |
| `DEV_TOOLS_DISABLED`            | 404    | A `/dev/rewards/*` route with `DEV_TOOLS_ENABLED` off      |

`INSUFFICIENT_REWARD_POINTS` deliberately carries no balance figure: the
client already has the authoritative balance from the snapshot, and restating
it in an error string invites clients to parse it back out and treat an error
as a data source.

---

## 10. Rate limits

| Route                    | Limit    |
| ------------------------ | -------- |
| `POST /rewards/check-in` | 30 / min |
| `POST /rewards/redemptions` | 10 / min |
| everything else          | app default (300 / min) |

These bound **lock pressure**, not fraud — each call opens a write
transaction that serialises on the caller's `User` row, and a 300/min loop
could make every other transaction for that account queue behind it. Fraud is
already a no-op thanks to the unique keys.

Same honest caveat as every other limit in `rate-limit.constants.ts`:
`ThrottlerGuard` keys on client IP, not user id, so an attacker rotating
addresses is not bounded by it and users behind one NAT share a bucket. The
load-bearing controls here are the database-backed ones.
