# Rewards API Contract

Canonical contract for the `/rewards/*` surface: the points wallet, the daily
check-in, the social and watch missions, the transaction ledger, and
redemption into ad perks.

Added by the work unit **"REWARDS BACKEND FOUNDATION"** and completed by
**"REWARDS V1 EARN AND SPEND"**, which closed the V1 loop —
**activity → earn coins → spend coins → a real perk** — that the foundation
slice deliberately left open. It is the backend
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

| Variable                        | Default        | Meaning                                                     |
| ------------------------------- | -------------- | ----------------------------------------------------------- |
| `REWARDS_ENABLED`               | `false`        | While false, **every** `/rewards/*` route answers `503 REWARDS_DISABLED`, no reward table is written, and no watch credit is recorded. |
| `REWARDS_TIMEZONE`              | `Asia/Jakarta` | IANA zone whose **calendar day** defines a reward day.       |
| `REWARDS_SOCIAL_INSTAGRAM_URL`  | unset          | Official Red Panda Instagram profile. Unset ⇒ that mission is not served at all. |
| `REWARDS_SOCIAL_TIKTOK_URL`     | unset          | As above, TikTok.                                            |
| `REWARDS_SOCIAL_YOUTUBE_URL`    | unset          | As above, YouTube.                                           |
| `REWARDS_SOCIAL_FACEBOOK_URL`   | unset          | As above, Facebook (optional fourth platform).               |

**Social URLs are validated at boot**, whether or not the feature is enabled.
A value that is set but not an `https` URL on that platform's own domain
pointing at a profile fails startup. An **unset** variable is not an error —
it means this deployment does not run that mission, which is how the feature
rolls out one platform at a time.

`npm run production:preflight` additionally **blocks** a release whose social
URL still contains a template segment such as `your-handle`: that shape passes
every boot rule and is still a profile nobody owns.

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

| Method | Path                                    | Purpose                                     |
| ------ | --------------------------------------- | ------------------------------------------- |
| `GET`  | `/rewards/snapshot`                     | The whole Rewards Center in one read        |
| `POST` | `/rewards/check-in`                     | Claim today's check-in                      |
| `POST` | `/rewards/missions/:missionId/open`     | Record a social-profile open, get the URL   |
| `POST` | `/rewards/missions/:missionId/claim`    | Claim a social mission or a watch milestone |
| `GET`  | `/rewards/perks`                        | What the ad gate needs: active perks        |
| `POST` | `/rewards/perks/:perkId/consume`        | Spend a single-use ad skip                  |
| `GET`  | `/rewards/ledger`                       | Paginated transaction history, newest first |
| `POST` | `/rewards/redemptions`                  | Spend points on an ad perk (or premium)     |
| `POST` | `/dev/rewards/grant`                    | **Dev only.** Credit points for the demo    |
| `GET`  | `/dev/rewards/reconcile`                | **Dev only.** Ledger-vs-projection check    |

The two `/dev/*` routes additionally require `DEV_TOOLS_ENABLED=true`, which
the app refuses to boot with outside `development`/`test`.

### 3.1 `GET /rewards/snapshot`

Returns `wallet`, `dailyCheckIn`, `watchTime`, `tasks`, `redemptions` and
`activePerks` in one response. **One call, not five** — the balance, the streak
strip, the mission progress and the redemption availability must agree with
each other, and independent requests can interleave with a claim and render a
balance that contradicts the tile beside it.

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

The debit, the receipt and whatever the offer buys — an ad perk or an
entitlement — are **one transaction**.

The response carries `perk` (non-null for an `AD_PERK` offer) and
`entitlementExpiresAt` (non-null for a `PREMIUM_DAYS` offer). **Exactly one of
the two is set** on a fulfilled receipt.

### 3.5 `POST /rewards/missions/:missionId/open`

Records that the server is sending this account to a social profile, and
returns the URL to send them to.

**Takes no body, and the URL comes back in the response.** A route that
*accepted* a destination would let a caller nominate where the app opens an
external browser — a phishing primitive handed out with Red Panda's branding
on it.

```json
{
  "missionId": "task_social_instagram",
  "destinationUrl": "https://www.instagram.com/redpanda",
  "openedAt": "2026-08-26T09:00:00.000Z",
  "claimableAfter": "2026-08-26T09:00:05.000Z",
  "task": { "...": "the refreshed tile" }
}
```

`claimableAfter` exists so the client can disable its confirm button for the
interval instead of letting a user tap it and receive an error. It is **not a
security boundary** — see §6.

Only social missions can be opened. A watch milestone answers
`REWARD_MISSION_NOT_OPENABLE`: there is nothing to open, it progresses as you
watch.

### 3.6 `POST /rewards/missions/:missionId/claim`

**Takes no body**, exactly like check-in and for the same reason: the amount
is the server's, the reward day is the server's, and the idempotency key is
derived from the mission id (plus the period, for a daily mission). Even
*which* mission comes from the path and is resolved against the catalog before
anything is paid.

Answers **200 in both cases**, like check-in:

| Situation                          | `alreadyClaimed` | `awardedPoints` |
| ---------------------------------- | ---------------- | --------------- |
| First claim                        | `false`          | the mission's   |
| Repeat / double-tap / retry        | `true`           | `0`             |

Refusals:

| Situation                                   | Code                          |
| ------------------------------------------- | ----------------------------- |
| Id not in the catalog                       | `REWARD_MISSION_NOT_FOUND` (404) |
| Real mission, not configured here           | `REWARD_MISSION_UNAVAILABLE` (409) |
| Social claim with no prior `open`           | `REWARD_MISSION_NOT_STARTED` (409) |
| Claimed within the dwell window             | `REWARD_MISSION_TOO_SOON` (409) |
| Watch milestone not reached                 | `REWARD_MISSION_NOT_COMPLETE` (409) |

### 3.7 `GET /rewards/perks`

The question the mobile ad layer asks before showing an interstitial.

```json
{
  "perks": [
    {
      "id": "clx…",
      "perkType": "SKIP_NEXT_INTERSTITIAL",
      "expiresAt": "2026-08-27T09:00:00.000Z",
      "remainingUses": 1,
      "grantedAt": "2026-08-26T09:00:00.000Z"
    }
  ],
  "skipNextInterstitial": true,
  "adFreeUntil": null
}
```

**Read the two booleans, not the array.** A client that inspected `perks[]`
and reimplemented "is a `SKIP_NEXT_INTERSTITIAL` active and unexpired?" would
be reimplementing a rule this server owns — and the two would drift, on a code
path where drift means showing an ad to someone who paid not to see one.

Deliberately separate from the snapshot: the ad gate consults this far more
often than anyone opens the Rewards Center, and it should not pay for a wallet
read, a streak read and a mission `COUNT` every time.

### 3.8 `POST /rewards/perks/:perkId/consume`

**The client must call this when it actually skips.** A perk the app "uses" by
quietly not showing an ad is a perk the server still believes the user holds —
the next ad break would skip again for free, and the receipt would stop
describing what happened.

Answers **200 with `alreadyConsumed: true`** on a repeat, not 409: a retried
consume after a dropped response is the ordinary case.

A `TEMPORARY_AD_PASS` is **refused** here (`REWARD_PERK_NOT_CONSUMABLE`). It is
spent by the clock; "consuming" one could only destroy time the user paid for.

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
`costPoints > 0`, `grantsDays >= 0`, `awardedPoints > 0` or null,
`remainingUses >= 0` or null). These are last-resort guards: a rewards
system whose only defence against a free-money bug is "every caller remembers
to check" is one careless commit away from being a faucet.

---

## 5. Earning and spending in V1

### The loop

```
  daily check-in          ─┐
  social follow missions   ├─►  COINS  ─►  ad perks  ─►  fewer interruptions
  watch milestones        ─┘
```

Every earn path is server-decided and server-keyed. Every spend path debits
and issues in one transaction.

### Earn: social follow missions

Configured per platform (§2). A mission pays **once per account, ever** — the
ledger key is `EXTERNAL_SOCIAL_ACTION:<missionId>` with no period in it, so
there is nothing to reset and nothing to farm.

The flow is two calls, and both halves are load-bearing:

1. `POST /rewards/missions/:id/open` — the server hands out the URL and
   records that it did.
2. `POST /rewards/missions/:id/claim` — the user confirms. A claim with no
   recorded open is refused.

**What this proves, exactly: nothing about a follow.** See §6.

### Earn: watch milestones

`task_watch_3_episodes` and `task_watch_5_episodes` count **distinct episodes
started within one reward day**, and reset with the day
(`WATCH_MILESTONE:<missionId>:<periodKey>`).

Progress comes from `RewardWatchCredit`, written by `RewardsWatchService` from
inside the playback path — **after** `enforceEntitlementGate` has authorised
the request, and never from a request body. `@@unique([userId, periodKey,
videoId])` is the anti-farming control: replaying `GET /videos/:id/playback`
for the same episode all day produces exactly one credit, so progress can only
advance by reaching for a *different* episode.

**What this proves, exactly:** that the server decided this account could play
this episode and handed it a URL. **Not** that bytes were fetched, that
anything rendered, or for how long. That is why the mission is named
`WATCH_EPISODES` and never `WATCH_TIME`, and why `watchTime` is still `null`
(§6).

Recording a credit can never fail playback: the call is made after the
playback URL is resolved, and it swallows and logs its own errors. Losing a
credit costs a user a few points; failing the request costs them the product.

### Spend: ad perks

| Offer                  | Cost | Buys                                        |
| ---------------------- | ---- | ------------------------------------------- |
| `redeem_skip_next_ad`  | 150  | One interstitial skip, valid 24h            |
| `redeem_ad_pass_2h`    | 600  | No interstitials for 2 hours                |

Both are `kind: "AD_PERK"` and grant `0` premium days.

**Liveness is derived from the clock, never read from `status`.** A perk stops
working at exactly `expiresAt` with no sweeper job involved — the failure this
avoids is a two-hour pass that keeps suppressing ads for a week because
nothing ran to mark it expired.

**Consumption is a single conditional `UPDATE`** whose WHERE clause carries
every precondition, so two concurrent consumes cannot both match: one spends
it, the other reports `alreadyConsumed`.

### Spend: premium days, and why V1 does not sell them

The VIP offers are still in the catalog and still work — under
`CONTENT_ACCESS_MODE=free` they are **withheld**, reported as `COMING_SOON`
with `unavailableReason: "NOT_APPLICABLE_IN_FREE_MODE"`, and refused
server-side.

The reason is the same honesty rule this document is built around: in a
deployment where every episode is already free, an offer that charges 1000
points to "unlock every premium episode" takes the points and changes nothing.
Selling that is selling nothing. Flipping the mode back restores them with no
code change and no lost history.

### Premium, when a deployment does sell it

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

## 6. What the evidence actually is — and what is still not implemented

This is the most important section of this document.

### Every claimable task states its own evidence class

`RewardTaskDto.verification` is sent on every claimable task, and there are
exactly two values. There is deliberately **no `PLATFORM_VERIFIED` member**:
nothing in V1 can produce one, and a union member nothing produces is an
invitation to produce it dishonestly.

| Value             | Meaning                                                                 | Used by            |
| ----------------- | ----------------------------------------------------------------------- | ------------------ |
| `SERVER_OBSERVED` | This backend itself performed or authorised the thing being rewarded.   | check-in, watch    |
| `USER_CONFIRMED`  | The account holder said they did it. The server did not observe it.     | social missions    |

### Social follow missions are USER-CONFIRMED, not verified

**Instagram, TikTok, YouTube and Facebook expose no API that answers "did user
X follow page Y" for an arbitrary user.** This backend therefore cannot verify
a follow, and nothing in it claims to:

- the ledger reason is `EXTERNAL_SOCIAL_ACTION`, never `VERIFIED_FOLLOW`;
- the wire field is `verification: "USER_CONFIRMED"`, on every social task in
  every state;
- the ledger entry's `metadata` carries the same string, so an auditor reading
  a movement sees the evidence class without knowing how missions work.

What the server knows is: **it handed this account a destination URL at a
recorded instant, and the account came back and confirmed at a later one.**
That is all. It does not know a follow happened, that the same person did it,
or that it outlasted collecting the points.

Paying a modest, once-per-account reward for that is a **product decision**,
and it is the decision V1 has taken. Pretending it is a verified follow would
be a lie told in a column name — the kind that survives long after everyone
who knew better has moved on.

Two shape checks bound the obvious abuse and are **honestly described as
shape, not security**:

- a claim with no recorded `open` is refused — a client cannot confirm a link
  the server never handed it;
- a claim inside `SOCIAL_MISSION_MIN_DWELL_SECONDS` (5s) of the open is
  refused. **A script can wait five seconds.** This is the smallest
  server-side expression of "you went and came back", not an anti-fraud
  control.

The control that actually bounds the cost is the once-per-account ledger key,
which no amount of waiting defeats.

**If a trusted verification integration is ever added**, the honest upgrade is
a NEW `verification` value alongside a new ledger reason — never a
redefinition of this one.

### Still not payable

| Task type     | Why it is not payable                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REWARDED_AD` | Must be credited only from the ad network's **server-side verification callback**, keyed on its transaction id. The entire ads surface in this backend is `GET /config/ads` — a read-only frequency config with no callback endpoint, no shared secret and no transaction id. Crediting a client "the ad finished" message is crediting an untrusted device that has an obvious incentive to lie. |
| `CAMPAIGN`    | Has no defined completion signal yet.                                                                                                                             |

Both are served with `isClaimSupported: false` and a machine-readable
`unsupportedReason`, and there is no claim path that would pay them. The flags
are *server-owned*, so the day a signal exists, flipping one makes every
already-installed client offer the claim with no mobile release.

### `watchTime` is still always `null`

An answer, not an omission, and **not contradicted by the watch missions**.
The mobile `watchTime` section means watch DURATION. This backend's only
duration-shaped data is `WatchProgress.positionSeconds`, a resume marker a
DEVICE writes and that *decreases* when a user rewatches. Summing it would not
be watch time — it would be a number that looks like watch time, which is
precisely the failure the mobile `WatchTimeProgressSource` union was designed
to prevent by refusing to offer a `LOCAL_TIMER` member.

The watch missions count a different, provable quantity — episodes the server
authorised — and are reported under `WATCH_EPISODES`, never through this
field.

### Also not built

Point expiry, streak repair, per-device anomaly detection, a rewarded-ad
server callback, and any platform follow-verification integration.

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

### Mobile work required by work unit "REWARDS V1 EARN AND SPEND"

The snapshot gained fields and one new task type. A client that does not know
them should skip what it does not understand, never crash.

| Change                                                    | What mobile must do                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `RewardTaskType` gained `WATCH_EPISODES`                   | **Extend the union.** It is a NEW member rather than a reuse of `WATCH_TIME` because the mission counts episodes, not time — see §6. |
| `task.verification`                                        | Render social tiles as user-confirmed. Never as "verified". |
| `task.destinationUrl` / `task.accountHandle`               | Show the handle; open the URL. Both server-owned. |
| `task.progress` `{current, required}`                      | Render the watch milestone bar from this, never from a local count. |
| `task.claimedAt` / `task.resetsAt`                         | "Claimed" state, and the daily reset countdown. |
| `snapshot.activePerks`                                     | Show what the user holds beside the offers that sell it. |
| `offer.kind` / `offer.perk` / `offer.unavailableReason`    | Describe an ad perk correctly, and word `COMING_SOON` by reason. |
| `POST /rewards/missions/:id/open` → open URL → `…/claim`   | The two-step social flow. A claim with no prior open is refused. |
| `GET /rewards/perks` before an interstitial                | Read `skipNextInterstitial` / `adFreeUntil`. Do not reimplement the rule. |
| `POST /rewards/perks/:id/consume` when a skip is used      | Otherwise the server still believes the perk is unspent. |

`isServerAuthoritative` looks redundant coming from a server. It is sent
because the mobile fixture set hardcoded it `false` — a snapshot arriving with
it `true` is how the client distinguishes real state from the preview data it
used to render. Omitting the field would make the flag unfalsifiable rather
than unnecessary.

---

## 8. Economics, and what is still unapproved

Every number lives in `src/rewards/rewards.constants.ts` and
`src/rewards/social-missions.constants.ts` — the check-in curve
(`10, 15, 20, 25, 30, 40, 100` over a 7-day repeating cycle, day 7 the bonus),
the social mission reward (50 each), the watch milestones (3 episodes/30pts,
5 episodes/50pts), and the redemption catalog (ad skip 150pts, 2h ad pass
600pts, VIP 1d/1000pts, 3d/2500pts, 7d/5000pts disabled).

The check-in and VIP figures are carried over verbatim from the mobile
placeholder fixtures so the local demo shows what it always did; the V1
mission and ad-perk figures are new and equally unapproved. **What changed is
where they are decided (server) and whether they are enforced (they now
are).**

The **destination URLs are deployment configuration**, not economics — they
live in the environment (§2), because a marketing team changing a handle must
not need a code release.

The values themselves remain **product-unapproved**. Still open, from the
mobile contract §8:

1. Daily check-in reward curve, cycle length, and whether a streak bonus exists.
2. Rewarded-ad reward value and daily cap — moot until a server callback exists.
3. Social-follow reward value. The **policy** question ("do we pay for an
   unverifiable action at all?") is now answered: V1 does, once per account,
   labelled `USER_CONFIRMED`. The AMOUNT is still unapproved.
4. Watch milestone thresholds and values (currently 3/30 and 5/50).
5. Ad-perk prices and durations (skip 150pts/24h shelf life; pass 600pts/2h).
6. VIP redemption costs and durations — inert while `CONTENT_ACCESS_MODE=free`.
7. Point expiry: do points expire, and on what schedule.
8. Service timezone for the daily boundary (assumed `Asia/Jakarta`).
9. Whether points ever carry a stated monetary value.

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
| `REWARD_MISSION_NOT_FOUND`      | 404    | Mission id is not in the catalog at all                    |
| `REWARD_MISSION_UNAVAILABLE`    | 409    | Real mission, not configured in this deployment            |
| `REWARD_MISSION_NOT_OPENABLE`   | 409    | A watch milestone has nothing to open                      |
| `REWARD_MISSION_NOT_STARTED`    | 409    | Social claim with no recorded `open`                       |
| `REWARD_MISSION_TOO_SOON`       | 409    | Claimed within the dwell window after opening              |
| `REWARD_MISSION_NOT_COMPLETE`   | 409    | Watch milestone not reached today                          |
| `REWARD_PERK_NOT_FOUND`         | 404    | No such perk, or it belongs to another account             |
| `REWARD_PERK_NOT_CONSUMABLE`    | 409    | A time-based pass is spent by the clock, not by a call     |
| `REWARD_PERK_EXPIRED`           | 409    | The perk's shelf life ran out before it was used           |
| `INVALID_ACCESS_TOKEN`          | 401    | Missing, malformed or expired credential                   |
| `DEV_TOOLS_DISABLED`            | 404    | A `/dev/rewards/*` route with `DEV_TOOLS_ENABLED` off      |

`INSUFFICIENT_REWARD_POINTS` deliberately carries no balance figure: the
client already has the authoritative balance from the snapshot, and restating
it in an error string invites clients to parse it back out and treat an error
as a data source.

---

## 10. Rate limits

| Route                                  | Limit    |
| -------------------------------------- | -------- |
| `POST /rewards/check-in`               | 30 / min |
| `POST /rewards/missions/:id/open`      | 20 / min |
| `POST /rewards/missions/:id/claim`     | 20 / min |
| `POST /rewards/redemptions`            | 10 / min |
| `POST /rewards/perks/:id/consume`      | 60 / min |
| everything else (incl. `GET /rewards/perks`) | app default (300 / min) |

`POST /rewards/perks/:id/consume` is the loosest override on purpose: it sits
on the AD PATH, is called whenever an interstitial would have been shown, and
a user who bought ad skips is a user who paid to be interrupted less.
Throttling them into seeing the ad anyway would be the worst possible failure
of the feature. `GET /rewards/perks` gets no override at all for the same
reason.

These bound **lock pressure**, not fraud — each call opens a write
transaction that serialises on the caller's `User` row, and a 300/min loop
could make every other transaction for that account queue behind it. Fraud is
already a no-op thanks to the unique keys.

Same honest caveat as every other limit in `rate-limit.constants.ts`:
`ThrottlerGuard` keys on client IP, not user id, so an attacker rotating
addresses is not bounded by it and users behind one NAT share a bucket. The
load-bearing controls here are the database-backed ones.
