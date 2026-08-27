# Red Panda V1 — Release Gate

```
npm run release:gate
```

One deterministic, **read-only** command that answers a single question before
a staging or production deployment:

> **Is this commit, and this configuration, a shippable Red Panda V1?**

It is the middle of a three-step release timeline this repository already had
the two ends of:

| | `npm run release:gate` | *deploy* | `npm run smoke:production` |
|---|---|---|---|
| **when** | before | the release | after |
| **judges** | the code and the configuration | — | a live origin |
| **changes anything?** | **no** | yes — the only step that does | no |
| **can prove** | it compiles, the rules accept a V1 posture, no dev artefact is wired in | — | it actually serves bytes |

---

## The three levels this document exists to keep apart

A green gate is easy to over-read. These three are **not** the same claim, and
the gate prints the distinction on every run.

### 1. ENGINEERING READY — what `release:gate` can prove

The code compiles, lints, and passes its production-config and HLS contract
suites. The Prisma schema is valid and its migration history is internally
consistent. The boot contract and the production preflight accept a
structurally complete V1 posture and refuse the postures they are meant to
refuse. No loopback address, LAN address, reserved domain, template
placeholder or hardcoded credential is compiled into release-bound source.

**This is a property of the repository.** It is decided entirely offline and
does not depend on any account, credential or host existing anywhere.

### 2. EXTERNAL CONFIG READY — what only `--mode=production` can begin to prove

A real candidate configuration — the actual variables a real deployment will
receive — satisfies every rule above. WhatsApp is enabled with the `cloud-api`
driver and all four Cloud API sender variables present. The three required
social mission URLs are set, well-shaped, and not templates. `PUBLIC_BASE_URL`
is a real public https origin, not a placeholder domain.

**This is a property of a configuration, and it is still structural.** It says
the values are *present and correctly shaped*. It cannot say the access token
is valid, the WhatsApp template is approved, the bucket has bytes in it, the
social handles belong to Red Panda, or the hostname resolves. Those facts are
held by Meta, Google, Cloudflare and DNS — never by this repository.

### 3. DEPLOYED / VERIFIED — what nothing in this repository can prove

A real origin is serving. One real OTP has reached one real phone. An episode
has played on a device. `npm run smoke:production` has passed against the
deployed origin, and the staging smoke matrix in
[`V1_STAGING_RUNBOOK.md`](./V1_STAGING_RUNBOOK.md) §7 has been walked by a
human.

> **A release gate exit code of 0 means the code and the configuration are
> structurally sound. It does not mean anything works.**

---

## Modes

`--mode` decides *which configuration is graded* and *how hard a policy
violation lands*. `ci` is the default.

| | `--mode=local` | `--mode=ci` *(default)* | `--mode=production` |
|---|---|---|---|
| **question** | does my working copy hold together? | is this **commit** capable of being a V1? | is **this configuration** a shippable V1? |
| **config source** | ambient `.env` (dotenv is loaded) | a synthetic fixture in `release-mode.ts` — the ambient environment is **ignored** | ambient process env only; **no** dotenv |
| **feature policy** | advisory (blockers become warnings) | blocking | blocking |
| **proves** | ENGINEERING READY for your tree | ENGINEERING READY for the commit | ENGINEERING READY + EXTERNAL CONFIG READY |

### Why CI mode ignores the environment

That is the load-bearing property. A CI verdict must be a fact about the
**commit**, not about whatever the runner happened to export. The synthetic
fixture (`buildStructuralV1Env`) is a complete V1 posture made of obviously
disposable values — `release-gate-structural-fixture-…-not-real` — chosen so
that:

- it satisfies every boot and preflight rule, so CI fails on the *code*, never
  on the fixture;
- no value in it could be pasted into a deployment and mistaken for real;
- its social URLs are built from `SOCIAL_MISSION_DEFINITIONS[].allowedHosts`,
  so they cannot go stale when a platform's allowlist changes.

### Why `--mode=production` does not load `.env`

For the same reason `scripts/production-preflight.ts` does not: a gate that
silently absorbed a developer's `.env` into a production verdict would grade
the wrong configuration and pass. Supply the real values explicitly:

```bash
env $(grep -v '^#' .env.production | xargs) npm run release:gate -- --mode=production
```

---

## What it checks

`npm run release:gate -- --list` prints this table from
`src/common/release-gate/release-gate.plan.ts`.

| Step | What |
|---|---|
| `build` | `npm run build` — the same compile CI gates on. |
| `lint` | `npm run lint:ci` — never the `--fix` variant, so the gate cannot edit the tree. |
| `test:config` | The database-free suites that grade the boot contract, the preflight and V1 policy. |
| `test:hls` | Playlist contract, rendition ladder, playback tokens, R2 precedence, safe URL generation. |
| `hls:entrypoints` | Structural: every media/HLS operational npm script still resolves to a file that exists. |
| `test:full` *(opt-in)* | The whole unit suite. Needs Postgres — see below. |
| `prisma:validate` | `npx prisma validate`. Parses the schema; opens no connection. |
| `prisma:history` | Offline: every migration has non-empty SQL, timestamps increase, provider agrees. |
| `prisma:status` *(opt-in)* | Read-only `prisma migrate status` against a database **you name**. |
| `preflight` | The full `runProductionPreflight` verdict over this mode's configuration. |
| `contract` | Google, WhatsApp, Rewards, the required social missions, free catalog, payments off. |
| `deletion-coverage` | Every supported sign-in provider maps to an implemented deletion proof, and every V1-required login provider is enabled so its proof is verifiable. |
| `leak-scan` | Classified scan of release-bound source and CI for dev artefacts and hardcoded credentials. |

### V1 account-deletion coverage

Added after a Google-only / WhatsApp-only account was found to have **no
deletion path at all** — `POST /users/me/deletion` demanded a password those
accounts never had. Nothing failed at the time: the build compiled, the
deletion tests passed (they all used password accounts), and the feature
contract confirmed both login providers were enabled — which was the problem,
since enabling them is what created the undeletable accounts. A human reading
the public website's privacy page found it.

The `deletion-coverage` step blocks on two properties
(`src/common/release-gate/v1-account-deletion-coverage.ts`):

1. **Structural.** Every provider in `AUTH_PROVIDERS` maps to an implemented
   `DeletionProofMethod`. The map is a total
   `Record<AuthProvider, DeletionProofMethod>`, so adding a fourth sign-in
   provider without deciding how its accounts delete themselves **fails to
   compile**; the gate restates it in the report so the release record says it
   in words rather than leaving it a property only the compiler knows.
2. **Environmental.** Every V1-required login provider is actually enabled.
   `GOOGLE_AUTH_ENABLED=false` is already blocked by the feature contract as a
   dead login button; this states the second, worse consequence — a server
   that cannot verify a Google proof leaves every Google-only account unable
   to delete itself.

It opens no connection and calls no route. Proof that each path WORKS is
`src/auth/deletion/deletion-authorization.service.spec.ts` and
`test/account-deletion-providers.e2e-spec.ts`; see
[`ACCOUNT_DELETION.md`](./ACCOUNT_DELETION.md).

### The V1 feature contract

Encoded as data in `src/common/release-gate/v1-feature-contract.ts`:

| Requirement | Variable | Expected | Strength |
|---|---|---|---|
| WhatsApp login | `WHATSAPP_AUTH_ENABLED` | `true` | **blocking** |
| Rewards | `REWARDS_ENABLED` | `true` | **blocking** |
| Free catalog | `CONTENT_ACCESS_MODE` | `free` | **blocking** |
| No payments | `PAYMENTS_ENABLED` | `false` (unset also satisfies) | **blocking** |
| Google login | `GOOGLE_AUTH_ENABLED` | `true` | **blocking** |
| Google client ids | `GOOGLE_OAUTH_CLIENT_IDS` | ≥1 non-empty client id | **blocking** |
| Instagram mission | `REWARDS_SOCIAL_INSTAGRAM_URL` | a real profile URL | **blocking** |
| TikTok mission | `REWARDS_SOCIAL_TIKTOK_URL` | a real profile URL | **blocking** |
| YouTube mission | `REWARDS_SOCIAL_YOUTUBE_URL` | a real profile URL | **blocking** |
| Facebook mission | `REWARDS_SOCIAL_FACEBOOK_URL` | — | **optional** |

Which social platforms are required is read from
`SOCIAL_MISSION_DEFINITIONS[].requiredForV1`, never re-listed — adding a
platform to the catalog cannot leave the gate grading the old list.

**Payments is the one place the gate is stricter than the preflight.** The
preflight *warns* on `PAYMENTS_ENABLED=true`, because a payments-enabled
backend boots perfectly well and "will it boot and be wrong" is all a
boot-readiness tool asks. The gate *blocks* it, because V1 is specified to ship
no purchase flow of any kind. `v1-feature-contract.spec.ts` pins that asymmetry
so it stays deliberate — and asserts that every *other* blocking requirement is
also refused by the preflight, so the two can never drift apart in silence.

**Google login is a BLOCKER, and used to be the one recommended item.** It was
recommended for a tool-agreement reason rather than a product one: the preflight
warned, so blocking here would have made the gate the stricter of two tools that
are supposed to agree. The confirmed V1 product contract requires **Google Login**
and **WhatsApp Login** alike, and the **mobile release preflight has always
treated Google as required** — so the old severity let the backend certify a
candidate the mobile side refused. Both tools now block. `GOOGLE_OAUTH_CLIENT_IDS`
is graded as its own requirement because the two failures differ: the flag off
ships a dead Google button, while the flag on with an empty allowlist does not
boot at all and would answer `401 INVALID_GOOGLE_TOKEN` to every real sign-in if
it did.

**CODE-CONFIGURED is not GOOGLE-VERIFIED.** A `PASS` on both rows means the flag
is on and at least one client id is present — nothing more. Whether the id exists
in a Google Cloud project, whether the OAuth consent screen is published, and
whether the Android client carries the Play App Signing SHA-1 are facts only
Google holds; the gate never contacts Google and never claims otherwise. Prove
those with one real Google sign-in against the deployed origin. The report never
echoes a client id — it prints a count. (The ids are public by design in any
case; no Google client **secret** exists or is read anywhere in this codebase.)

**This is a RELEASE rule, not a BOOT rule.** `validateEnv` still starts a process
with `GOOGLE_AUTH_ENABLED` unset, `local` mode grades the whole feature policy as
advisory, and development, test and CI keep running with no Google configuration
at all.

---

## What it will never do

- deploy, push, or run a migration
- write to any database, R2 bucket or Redis instance
- enqueue a transcode job or touch any media
- send a WhatsApp message, or contact Meta, Google, AdMob or Cloudflare
- require a real external credential
- print a secret value
- **report a pass for a check that did not run**

It connects to a database only when one is named explicitly in
`RELEASE_GATE_DATABASE_URL`, and even then only to *read* `prisma migrate
status`. The ambient `DATABASE_URL` is deliberately ignored: on a developer
machine it names the shared local dev database, and a confident answer about
the wrong database is worse than no answer.

---

## Opt-in checks, and why they are opt-in

Two steps report **SKIPPED** by default. A skipped step is never counted as a
pass, is printed in its own section with the reason, and is repeated in the
verdict line — because a gate that got greener the less it could verify would
be worse than no gate.

### `test:full` — `--with-db-tests`

Over a third of this repository's unit suites (53 of 137 at the time of
writing) talk to Postgres (they are integration tests wearing a `.spec.ts`
extension, by long-standing precedent here). Running them uninvited would write
fixtures into whatever database the ambient `DATABASE_URL` names. CI runs them
in its own `quality-gate` job against a throwaway Postgres; locally, opt in
against a database you have chosen:

```bash
npm run release:gate -- --mode=local --with-db-tests
```

Two refusals guard this flag, and both exit `2` rather than blocking the
release — the invocation was wrong, not the release:

- **`--with-db-tests` is refused outright in `--mode=production`.** In that
  mode `DATABASE_URL` is the *real candidate database*, and the unit suite
  creates and deletes fixture rows. There is no version of "grade my
  production configuration" that should also mean "write test users into it".
- **An absent `DATABASE_URL` is refused, never defaulted.** The gate does not
  pick a database for you, and it deliberately does *not* fall back to
  `RELEASE_GATE_DATABASE_URL` — that variable names the database the
  read-only migration-status check inspects, which may be staging, and a test
  suite writes to what it is given.

### `prisma:status` — `RELEASE_GATE_DATABASE_URL`

```bash
RELEASE_GATE_DATABASE_URL='postgresql://…/short_drama_staging' \
  npm run release:gate -- --mode=production
```

Runs `prisma migrate status` — read-only — against that database and reports:

- **PASS** — schema up to date;
- **WARNING** — migrations pending. *Not* a blocker: `start:migrate:prod` runs
  `prisma migrate deploy` as its first act, so pending migrations are the
  normal state immediately before a release that ships a schema change.
  Confirm against [`V1_STAGING_RUNBOOK.md`](./V1_STAGING_RUNBOOK.md) §5 that
  every pending migration is additive;
- **BLOCKER** — a failed migration is recorded, or Prisma reports drift.

---

## The leak scan

A naive grep for `localhost` over this repository returns dozens of hits, and
every current one is legitimate — rejection allowlists, operator error
messages, prose in comments, test fixtures. A scanner that reported those would
be switched off within a week, and then the one real leak would ship. So the
scan **classifies** in three layers:

1. **File class.** Specs, `test/`, `src/common/testing/`, docs, `.env*.example`
   and lockfiles are not graded as production code. CI workflows are graded by
   their own rule.
2. **Line class.** A match inside a comment is prose. This repository explains
   its security rules in long comments that necessarily quote the strings those
   rules reject.
3. **A curated exemption inventory** in `leak-exemptions.ts`, keyed by path
   **and by a substring of the line itself** — so an exemption cannot drift
   onto a different line, and anything new is reported. Rejection tables such
   as `PLACEHOLDER_LABELS` are covered as a *declaration span* that stops at
   its closing bracket, so a leak added below the table still blocks. Every
   entry is asserted to stay *reachable* — its file in a scanned class, still
   present, still containing the anchor text — because a dead exemption reads
   as a reviewed justification while covering nothing.

Two pattern-level rules remove whole classes of false positive rather than
needing an exemption each: `SOME_PATTERN.test(value)` is not a `.test` reserved
domain, and `INVALID_REFRESH_TOKEN = 'INVALID_REFRESH_TOKEN'` is not a
hardcoded credential.

**CI workflows are held to one strong rule:** a credential-shaped value must
say in its own text that it is disposable (`ci-test-only-…-not-a-real-
credential`). An opaque value that *might* be real blocks — because nobody
reviewing the diff could tell the difference.

A `hardcoded-credential` finding prints the file, the line number and the
**variable name**. Never the value.

---

## In CI

`.github/workflows/ci.yml` runs the gate as a separate `release-gate` job with
**no `services:` block, no database and no secrets**. That absence is the
point: the verdict is a fact about the commit. The job contacts no external
Meta, Google, AdMob, R2 or Redis service and applies no migration.

It does not duplicate the database-backed suites — the existing `quality-gate`
job already runs those against its own throwaway Postgres.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No blockers. Warnings and skips may still be present — **read them.** |
| `1` | At least one blocker. This release must not be deployed. |
| `2` | The gate itself could not run (bad arguments). |

---

## See also

- [`V1_STAGING_RUNBOOK.md`](./V1_STAGING_RUNBOOK.md) — the environment
  inventory, the release configuration matrix, the migration procedure and the
  staging smoke matrix. §11 is the same CODE-VALID / EXTERNALLY-VERIFIED
  distinction stated for the whole release.
- [`PRODUCTION_HTTPS.md`](./PRODUCTION_HTTPS.md) — the boot contract's public
  URL rules.
- [`WHATSAPP_LOGIN_SETUP.md`](./WHATSAPP_LOGIN_SETUP.md) — the Meta
  credentials the gate can only check for presence.
