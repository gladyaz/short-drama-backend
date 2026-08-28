export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  storageRoot: string;
  corsOrigins: string[];
  /** Phase 10, work unit 10-B5: gates dev-only entitlement grant/revoke routes. */
  devToolsEnabled: boolean;
  /**
   * PRODUCTION HTTPS READINESS: how many reverse proxies sit in front of
   * this process. `0` (the default) means "no proxy" and leaves Express's
   * `trust proxy` OFF — byte-for-byte the behavior this app has always had.
   *
   * WHY THIS EXISTS. Every per-IP control in this codebase reads
   * `request.ip`: the global `ThrottlerGuard` (@nestjs/throttler 6.5.0's
   * default tracker is literally `req.ip`), every `@Throttle()` override
   * (`LOGIN_RATE_LIMIT = 5/min`, `WHATSAPP_OTP_REQUEST_RATE_LIMIT = 3/10min`,
   * ...), and `requestContext()`'s `ip` — which becomes `Session.ipHash` and
   * `AuthAuditEvent.ipHash`. Behind a TLS-terminating proxy with `trust
   * proxy` off, `request.ip` is the PROXY's address for every caller, so all
   * of those collapse onto ONE bucket: the 5-logins-per-minute ceiling
   * becomes 5 logins per minute for the entire user base, and every audit
   * row hashes the same address.
   *
   * WHY A HOP COUNT AND NOT `true`. `trust proxy: true` trusts the whole
   * `X-Forwarded-For` chain, so any client can prepend a forged address and
   * mint itself an unlimited number of rate-limit identities. A NUMBER tells
   * Express to skip exactly that many trusted hops from the right and take
   * the next value, which a client cannot forge past. Set it to the real
   * number of proxies (1 for a single managed platform router/ingress).
   */
  trustProxyHops: number;
}

export interface AuthConfig {
  /** Signing secret for short-lived access tokens. Never logged. */
  jwtAccessSecret: string;
  /** Signing secret for the (separately, DB-hashed) refresh token. Never logged. */
  jwtRefreshSecret: string;
  /**
   * Phase 12, work unit 12A-B3: DEDICATED HMAC key used to hash client IP
   * addresses before they are persisted to `AuthAuditEvent.ipHash` (see
   * `AuthAuditService`). Deliberately a separate secret from
   * `jwtAccessSecret`/`jwtRefreshSecret` (DECISIONS.md "Phase 12 ...
   * approved..." entry, decision 6: "a dedicated secret, distinct from the
   * JWT/refresh-token signing secrets") so that rotating one never silently
   * changes the other's blast radius. Never logged.
   *
   * Phase 12, work unit 12B-B2 update: this SAME field is now ALSO used
   * (via the shared `hashIp` helper in `src/auth/auth-crypto.ts`) to hash
   * client IPs for `Session.ipHash` — it already satisfies decision 6's
   * "dedicated secret" requirement for that column too, so no second env
   * var was introduced for it (see `.env.example`).
   */
  authAuditIpHashSecret: string;
}

/**
 * Phase 11, work unit 11G-3: which storage backend the app is configured
 * for. `local` is the default (unset/empty `STORAGE_DRIVER` resolves to
 * `local`) and preserves today's existing behavior byte-for-byte — nothing
 * in this slice changes what `StorageService`/`StorageModule` actually do
 * with this value; wiring real R2 usage behind `driver === 'r2'` is a
 * separate, later, human-gated unit. `r2` is only meaningful once
 * `env.validation.ts` has confirmed (name-presence only, never value) that
 * every `OBJECT_STORAGE_*` variable required by `StorageService` is set.
 */
export type StorageDriver = 'local' | 'r2';

export const STORAGE_DRIVERS: readonly StorageDriver[] = ['local', 'r2'];

export const DEFAULT_STORAGE_DRIVER: StorageDriver = 'local';

/**
 * Phase 11, work unit 11A-1: provider-agnostic S3-compatible object storage
 * config, read by `StorageModule`/`StorageService`. Named generically
 * (`OBJECT_STORAGE_*`, not `R2_*`) because the service itself is
 * provider-agnostic even though Cloudflare R2 is the approved target
 * provider (see DECISIONS.md "Phase 11 (Production Media Storage...)
 * approved..." entry). Real credentials are a human action deferred to
 * 11A-3, out of scope here.
 *
 * Phase 11, work unit 11G-3 update: `OBJECT_STORAGE_*` variable NAMES are
 * now required by `env.validation.ts`, but ONLY when `STORAGE_DRIVER=r2`
 * (see `driver` below); in the default `local` mode they remain fully
 * optional, exactly as before this unit.
 *
 * Phase 11, work unit 11H-B1 update: `publicBaseUrl` is `string | undefined`
 * (not `string`), and the factory below no longer falls back to `?? ''`.
 * This is deliberate: `OBJECT_STORAGE_PUBLIC_BASE_URL` is optional even in
 * `r2` mode (see `env.validation.ts`'s `REQUIRED_R2_KEYS`), and an empty
 * string is a worse failure mode than a missing one — `''` would let
 * `StorageService.buildPublicUrl` silently assemble `"/videos/abc.mp4"`,
 * which *looks* like a valid relative path. `undefined` instead forces
 * `buildPublicUrl` to throw a clear configuration error (see its doc
 * comment in `storage.service.ts`) rather than ever returning a bogus URL.
 */
export interface StorageConfig {
  driver: StorageDriver;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string | undefined;
}

/**
 * Slice 11N — HLS Processing Data Model + Queue Foundation (control
 * workspace DECISIONS.md "2026-08-10 — Slice 11N APPROVED..." entry).
 * `enabled` mirrors `RetentionScheduleConfig.enabled`'s existing
 * **fail-closed, exact-string** shape exactly (`resolveRetentionScheduleConfig`
 * in `../retention/retention-schedule.config.ts`): `TRANSCODE_ENABLED` must
 * be the literal string `"true"` to activate anything — absent, empty,
 * `"TRUE"`, `"1"`, `"yes"`, or any other value all resolve to `false`, never
 * the reverse. `false` is this slice's only shipped state (2026-08-10
 * approval, prohibition list: "no `TRANSCODE_ENABLED=true` anywhere").
 *
 * `redisUrl` is read unconditionally by this factory (mirroring every other
 * field here — `configuration.ts` never itself decides what is
 * required/optional, `env.validation.ts` does), but is REQUIRED (by
 * `env.validation.ts`'s `validateTranscodeConfig`) only when `enabled` is
 * `true`. While `enabled` is `false`, nothing in this codebase ever reads
 * `redisUrl` — its absence, or an unreachable value, is completely
 * harmless. Never logged anywhere (see `TranscodeReadinessService`, which
 * reports presence only, never the value).
 */
/**
 * Slice 11P — Production Transcoding Lifecycle (control workspace
 * DECISIONS.md "2026-08-10 — Slice 11P APPROVED..." entry). Three additional
 * tunables, all resolved unconditionally by this factory (mirroring
 * `redisUrl`'s existing "read unconditionally, `env.validation.ts` decides
 * what's required" split) but only ever consulted by code that itself is
 * behind `TRANSCODE_ENABLED` — while the flag is `false` (this repo's only
 * shipped state), none of these three values affects anything.
 *
 * Each has a documented, sane default (`DEFAULT_TRANSCODE_MAX_ATTEMPTS`,
 * `DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES`,
 * `DEFAULT_TRANSCODE_CLEANUP_GRACE_MINUTES` below) and is OPTIONAL even when
 * the flag is on — unlike `REDIS_URL`, an admin does not need to set any of
 * these three just to turn transcoding on. `env.validation.ts`'s
 * `validateTranscodeConfig` additionally fails boot loudly (only when the
 * flag is `"true"`) if a PRESENT value for one of these three is not a valid
 * positive integer — matching the 11G-3 conditional-validation pattern.
 */
export interface TranscodeConfig {
  enabled: boolean;
  redisUrl: string | undefined;
  /** Hard cap on processing attempts per generation before a job gives up permanently (`failed`, `MAX_ATTEMPTS_EXCEEDED`). */
  maxAttempts: number;
  /** How long a row may sit in `processingState = "running"` before `TranscodeJanitorService` treats it as stalled and CAS-fails it (`STALE`). */
  stalledAfterMinutes: number;
  /**
   * How long an orphaned/superseded HLS staging prefix must sit untouched
   * before `TranscodeJanitorService` deletes it. Deliberately LONGER than
   * the 30-60 minute playback-token TTL design target for the future 11Q
   * gateway (proposal §9, decision 8) — see
   * `TranscodeJanitorService`'s doc comment — so a generation a mobile client
   * may still hold a live authorization token for is never deleted out from
   * under it, even though this slice never issues such a token itself.
   */
  cleanupGraceMinutes: number;
  /**
   * VPS DEPLOYMENT: how many transcode jobs one worker process runs at
   * once (BullMQ `Worker`'s `concurrency`). Optional even when the flag is
   * on — defaults to `DEFAULT_TRANSCODE_WORKER_CONCURRENCY` (1), and is
   * NEVER derived from the machine's CPU count; see that constant's doc
   * comment for why, and `docs/TRANSCODE_WORKER_VPS.md` for sizing.
   */
  workerConcurrency: number;
  /**
   * VPS DEPLOYMENT: the parent directory each job's own isolated
   * `fs.mkdtemp` working directory is created under. `undefined` (the
   * default) means `os.tmpdir()`, preserving the pre-existing behavior
   * exactly.
   *
   * Exists so a container can point transcoding scratch space at a mounted
   * volume with real headroom instead of an image's small default `/tmp` —
   * a single job holds the downloaded source AND the full HLS package on
   * this filesystem simultaneously. Never a secret (it is a path, and
   * `redactSensitiveText` maps `STORAGE_ROOT` specifically, not this).
   */
  tempDir: string | undefined;
  /**
   * VPS DEPLOYMENT: how long a leftover per-job temp directory must sit
   * untouched before `sweepStaleWorkerTempDirs` removes it. Optional, with
   * `DEFAULT_TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES` as the documented
   * default — see that constant for why it is deliberately longer than the
   * stalled-row threshold.
   */
  tempSweepMinAgeMinutes: number;
}

/**
 * PRODUCTION HTTPS READINESS default for `AppConfig.trustProxyHops`: ZERO,
 * i.e. Express's `trust proxy` stays OFF unless a deployment explicitly says
 * how many proxies are in front of it. Deliberately fail-closed in the
 * direction that CANNOT be abused: with no proxy configured a real proxy
 * deployment over-throttles (an availability problem the operator sees
 * immediately and fixes with one variable), whereas a wrong non-zero value
 * would let a client forge its own rate-limit identity via
 * `X-Forwarded-For` — a silent security hole. Never guessed from NODE_ENV.
 */
export const DEFAULT_TRUST_PROXY_HOPS = 0;

/** Slice 11P default for `TranscodeConfig.maxAttempts` (proposal §8: "3 attempts"). */
export const DEFAULT_TRANSCODE_MAX_ATTEMPTS = 3;

/** Slice 11P default for `TranscodeConfig.stalledAfterMinutes`. */
export const DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES = 30;

/**
 * Slice 11P default for `TranscodeConfig.cleanupGraceMinutes` — explicitly
 * longer than the 30-60 minute playback-token TTL design target
 * (proposal §9, decision 8) so a generation a viewer may still be mid-playback
 * on is never grace-deleted out from under them once that future gateway
 * ships.
 */
export const DEFAULT_TRANSCODE_CLEANUP_GRACE_MINUTES = 120;

/**
 * VPS DEPLOYMENT default for `TranscodeConfig.workerConcurrency` — how many
 * transcode jobs ONE worker process runs at once (BullMQ `Worker`'s
 * `concurrency`, threaded in by `src/worker/main.ts`).
 *
 * Stays `1`, and is NEVER derived from `os.cpus().length`. An FFmpeg rung
 * encode is both CPU- and memory-hungry, and every concurrent job
 * additionally holds a full downloaded source PLUS a complete HLS package on
 * local disk at the same time (see `TRANSCODE_WORKER_TEMP_DIR_PREFIX`) — so
 * "one job per core" would exhaust RAM and disk on a small VPS long before
 * it exhausted CPU, and would also starve the API if the two ever shared a
 * box (proposal §1/§13). Raising it is an explicit operator decision made
 * against a measured machine; `docs/TRANSCODE_WORKER_VPS.md`
 * ("Concurrency sizing") carries the per-size guidance.
 */
export const DEFAULT_TRANSCODE_WORKER_CONCURRENCY = 1;

/**
 * VPS DEPLOYMENT default for `TranscodeConfig.tempSweepMinAgeMinutes` — how
 * long a leftover per-job temp directory must sit untouched before
 * `sweepStaleWorkerTempDirs` (`../transcode/transcode-temp.ts`) deletes it.
 *
 * Deliberately LONGER than `DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES` (30).
 * The sweep runs at worker startup and on the janitor interval, and on a box
 * running more than one worker it can see a directory belonging to another
 * process's still-running job. Anchoring the threshold above the point at
 * which the DB-level janitor would ALREADY have declared such a row stalled
 * means anything old enough for this sweep to delete is, by construction, no
 * longer owned by a live job.
 */
export const DEFAULT_TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES = 120;

/**
 * Slice 11Q — Private HLS Delivery Gateway (control workspace DECISIONS.md
 * "2026-08-10 — Slice 11Q APPROVED..." entry; architecture:
 * proposals/phase-11-hls-pipeline-proposal.md §9/§9a). Mirrors
 * `TranscodeConfig`'s "read unconditionally here, `env.validation.ts`
 * decides what's required" split exactly.
 *
 * `baseUrl`/`tokenSecret` are both `string | undefined` (never defaulted
 * to `''`) — an empty string is a worse failure mode than a genuinely
 * missing value (same rationale as `StorageConfig.publicBaseUrl`, 11H-B1):
 * `VideosService`'s HLS branch treats either as "not configured" and fails
 * CLOSED with `HLS_GATEWAY_NOT_CONFIGURED` rather than ever minting a
 * token against an empty secret or assembling a URL against an empty base.
 *
 * `ttlSeconds` DOES have a sane default (`DEFAULT_HLS_TOKEN_TTL_SECONDS`)
 * since it is not itself a secret/endpoint value — proposal §9/decision 8:
 * "design target 30-60 minutes; the final TTL must be validated by real
 * playback QA" — 3600s (60 min, the upper end of that target range) is
 * used as the shipped default pending that QA; `HLS_TOKEN_TTL_SECONDS`
 * lets it be tuned without a code change once QA has an answer.
 */
export interface HlsGatewayConfig {
  baseUrl: string | undefined;
  tokenSecret: string | undefined;
  ttlSeconds: number;
}

/**
 * Slice 11Q default for `HlsGatewayConfig.ttlSeconds` — see that field's
 * doc comment. NOT FROZEN (explicitly, per the 2026-08-10 approval,
 * binding constraint 3: "TTL design target 30-60 min, NOT frozen (physical
 * QA decides)").
 */
export const DEFAULT_HLS_TOKEN_TTL_SECONDS = 3600;

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": Midtrans Snap payment
 * provider configuration, mirroring `TranscodeConfig`'s "read
 * unconditionally here, `env.validation.ts` decides what's required" split
 * exactly.
 *
 * `enabled` follows the fail-closed, exact-string `TRANSCODE_ENABLED`
 * precedent: `PAYMENTS_ENABLED` must be the literal string `"true"` to
 * activate anything — absent, empty, `"TRUE"`, `"1"`, `"yes"`, or any other
 * value all resolve to `false`, never the reverse. While `false` (the
 * default posture), the Midtrans gateway is an inert
 * `DisabledMidtransGateway`, `POST /payments/checkout` and the webhook
 * endpoint answer `503 PAYMENTS_DISABLED`, and no `MIDTRANS_*` variable is
 * required at boot.
 *
 * `midtransServerKey` is `string | undefined` (never defaulted to `''`) —
 * the same "an empty string is a worse failure mode than a missing one"
 * rationale as `HlsGatewayConfig.tokenSecret`: nothing may ever compute a
 * webhook signature or an Authorization header against an empty key.
 * Required (name-presence only, value never logged) by
 * `env.validation.ts`'s `validatePaymentsConfig` when `PAYMENTS_ENABLED` is
 * `"true"`. NEVER logged, NEVER serialized into any API response.
 *
 * `midtransIsProduction`: exact-string `"true"` selects the PRODUCTION
 * Midtrans endpoints (`app.midtrans.com`/`api.midtrans.com`); every other
 * value — including unset — selects SANDBOX. Production mode can never
 * become the default, and `env.validation.ts` additionally refuses to boot
 * with `MIDTRANS_IS_PRODUCTION=true` unless `NODE_ENV` is exactly
 * `"production"` (a fail-closed allowlist, mirroring
 * `validateDevToolsNodeEnv`'s shape in reverse), so a dev/test machine can
 * never accidentally reach the real-money endpoint.
 */
export interface PaymentsConfig {
  enabled: boolean;
  midtransServerKey: string | undefined;
  midtransIsProduction: boolean;
}

/**
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS. Google + WhatsApp provider
 * configuration, mirroring `PaymentsConfig`/`TranscodeConfig`'s "read
 * unconditionally here, `env.validation.ts` decides what is required"
 * split exactly.
 *
 * Both `enabled` flags follow the fail-closed, exact-string precedent
 * `TRANSCODE_ENABLED`/`PAYMENTS_ENABLED` set: the value must be the literal
 * string `"true"` to activate anything — absent, empty, `"TRUE"`, `"1"`,
 * `"yes"` and every other value resolve to `false`, never the reverse.
 * `false` is this repository's shipped default for both, which is what
 * makes "production execution fails closed until configured" true by
 * construction rather than by discipline: with the flag off, `AuthModule`
 * binds the inert `DisabledGoogleIdentityVerifier` /
 * `DisabledWhatsAppOtpProvider`, the routes answer
 * `503 GOOGLE_AUTH_DISABLED` / `503 WHATSAPP_AUTH_DISABLED`, and no
 * provider-specific variable is required at boot.
 *
 * EMAIL/PASSWORD HAS NO FLAG, deliberately. It is not an optional provider
 * that can be switched off — it is the always-available baseline this phase
 * adds alongside, and there must be no configuration under which an
 * existing account loses the ability to sign in the way it always has.
 *
 * `googleClientIds` is the exact-match `aud` allowlist for ID-token
 * verification. It is a LIST because one backend legitimately serves
 * several OAuth clients (Android, iOS and web each get their own client
 * id). These values are NOT secrets — a Google OAuth client id ships inside
 * the mobile app binary and is public by design — but they are still read
 * from the environment rather than committed, so a deployment can change
 * them without a code change. The OAuth client SECRET is deliberately NOT
 * part of this config and is never read anywhere in this codebase:
 * verifying an ID token requires only Google's public keys and the client
 * id, so there is no reason for this backend to hold the secret at all,
 * and a secret that is never held cannot be leaked.
 *
 * `whatsappOtpDriver` names WHICH `WhatsAppOtpProvider` implementation to
 * bind: `cloud-api` (the production driver) or `fake` (refused outside
 * `development`/`test` by `env.validation.ts`). There is no default: with
 * `WHATSAPP_AUTH_ENABLED=true` and no valid driver, the process refuses to
 * boot rather than starting a backend that accepts OTP requests and
 * delivers nothing.
 *
 * ================= THE `whatsappCloudApi*` GROUP =================
 *
 * Read unconditionally here and required by `env.validation.ts` only when
 * the flag is on AND the driver is `cloud-api` — the same split every other
 * provider group in this file uses.
 *
 * EXACTLY ONE OF THEM IS SECRET: `whatsappCloudApiAccessToken`. The phone
 * number id, template name and template language are operational
 * identifiers, not credentials — they appear in Meta's own dashboard URLs —
 * but they are still read from the environment rather than committed,
 * because they differ per deployment and a code change to move between a
 * test number and a production number would be absurd. The token is the one
 * value that must never be logged, echoed in an error, or printed by
 * preflight; `redactSensitiveText`'s `token` keyword already covers the
 * variable name, and `WhatsAppCloudApiOtpProvider` never reads it back after
 * construction.
 *
 * `whatsappCloudApiGraphVersion` is OPTIONAL and falls back to the version
 * the client was written against (`DEFAULT_WHATSAPP_GRAPH_VERSION`). It
 * exists so an operator can move to a newer Graph version deliberately,
 * without a code change — never so the client can silently float.
 *
 * `whatsappCloudApiTemplateHasOtpButton` defaults to TRUE, matching Meta's
 * requirement that an OTP be delivered by an AUTHENTICATION-category
 * template, which must carry a one-time-password button. It exists only for
 * the genuinely different case of a non-authentication template with no
 * button — see `WhatsAppCloudApiOtpProvider`. Note the inverted flag
 * parsing: this one defaults ON, so it is `!== 'false'` rather than the
 * `=== 'true'` shape used by every fail-closed FEATURE flag here. That is
 * deliberate and not an inconsistency — a feature flag must fail closed
 * (off), whereas this describes the shape of the operator's template, whose
 * safe default is the shape Meta requires.
 */
export interface IdentityProvidersConfig {
  googleEnabled: boolean;
  googleClientIds: string[];
  whatsappEnabled: boolean;
  whatsappOtpDriver: string | undefined;
  whatsappCloudApiPhoneNumberId: string | undefined;
  /** SECRET. Never logged, never echoed, never returned by preflight. */
  whatsappCloudApiAccessToken: string | undefined;
  whatsappCloudApiTemplateName: string | undefined;
  whatsappCloudApiTemplateLanguage: string | undefined;
  whatsappCloudApiGraphVersion: string | undefined;
  whatsappCloudApiTemplateHasOtpButton: boolean;
}

/**
 * Work unit "REWARDS BACKEND FOUNDATION". `enabled` defaults OFF, matching
 * `PaymentsConfig`/`TranscodeConfig`'s precedent — a feature ships dark and
 * an operator turns it on deliberately. The local Android demo sets
 * `REWARDS_ENABLED=true` in its own `.env`; nothing in this repository ships
 * it on.
 *
 * `timezone` is the IANA zone whose calendar day defines a reward day. It is
 * resolved permissively here (absent/blank falls back to the documented
 * default) and validated strictly in `env.validation.ts`, matching the
 * "validate elsewhere, resolve permissively here" split the storage and
 * transcode config already use.
 */
/**
 * The IANA timezone whose calendar day defines a "reward day".
 *
 * Pinned to one SERVER-SIDE zone rather than read from the device, because a
 * device-derived boundary is trivially farmed: set the phone clock forward,
 * collect another day's check-in, repeat. The mobile domain contract states
 * the rule directly — "never trust a device clock or device timezone: both
 * are user-settable". `Asia/Jakarta` is the app's audience timezone and the
 * assumption that contract already records.
 *
 * Declared here beside `DEFAULT_STORAGE_DRIVER` and
 * `DEFAULT_TRANSCODE_MAX_ATTEMPTS` rather than in `rewards.constants.ts`,
 * following this file's existing convention: config defaults live with the
 * config factory (which deliberately imports nothing), while
 * `rewards.constants.ts` owns the ECONOMICS. A timezone is deployment
 * configuration, not a reward value.
 */
export const DEFAULT_REWARDS_TIMEZONE = 'Asia/Jakarta';

export interface RewardsConfig {
  enabled: boolean;
  timezone: string;
}

/**
 * Work unit "V1 FREE ACCESS POLICY": which content-access policy this
 * deployment enforces. Shaped exactly like the `STORAGE_DRIVER` precedent
 * above (`StorageDriver`/`STORAGE_DRIVERS`/`DEFAULT_STORAGE_DRIVER` +
 * `resolveStorageDriver` here, `validateStorageDriver` in
 * `env.validation.ts`) rather than as an exact-string boolean flag, because
 * this is a CHOICE BETWEEN NAMED POLICIES, not an on/off switch — a future
 * third mode has somewhere to go, and a typo fails the boot loudly instead
 * of silently resolving to whichever mode `!== 'free'` happens to mean.
 *
 * `entitlement` (the DEFAULT — unset/empty also resolves here) is
 * byte-for-byte today's behavior: an episode's effective tier is its
 * explicit `Video.accessTierOverride` when set, otherwise the
 * `episodeNumber > FREE_EPISODE_LIMIT` derivation, and a `premium` episode
 * requires an active `Entitlement` to stream.
 *
 * `free` is the Red Panda V1 Google Play policy: the app ships free and
 * ad-monetized with NO purchase flow of any kind, so a published episode
 * that resolves `premium` is not "locked behind a paywall", it is
 * PERMANENTLY UNREACHABLE. In this mode every published catalog episode
 * resolves `free` — see `resolveAccessTier`
 * (`../entitlements/entitlement.constants.ts`) for the single line that
 * implements it, and for why the mode deliberately outranks even an
 * explicit per-row `premium` override.
 *
 * WHAT THIS IS NOT. It is not a switch that grants anybody premium, and it
 * writes nothing: the `Entitlement` model/service, reward redemption,
 * payments, the `accessTierOverride` column and every value stored in it,
 * the gate itself, and the premium DTO types are all untouched and stay
 * live. Flipping this back to `entitlement` restores the previous
 * enforcement exactly, because the catalog still holds the same tiers it
 * always did.
 */
export type ContentAccessMode = 'entitlement' | 'free';

export const CONTENT_ACCESS_MODES: readonly ContentAccessMode[] = [
  'entitlement',
  'free',
];

export const DEFAULT_CONTENT_ACCESS_MODE: ContentAccessMode = 'entitlement';

export interface ContentConfig {
  accessMode: ContentAccessMode;
}

export interface RootConfig {
  app: AppConfig;
  auth: AuthConfig;
  storage: StorageConfig;
  transcode: TranscodeConfig;
  hlsGateway: HlsGatewayConfig;
  payments: PaymentsConfig;
  identityProviders: IdentityProvidersConfig;
  rewards: RewardsConfig;
  content: ContentConfig;
}

export default (): RootConfig => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    storageRoot: process.env.STORAGE_ROOT ?? '',
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    devToolsEnabled: process.env.DEV_TOOLS_ENABLED === 'true',
    trustProxyHops: parseNonNegativeIntEnv(
      process.env.TRUST_PROXY_HOPS,
      DEFAULT_TRUST_PROXY_HOPS,
    ),
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    authAuditIpHashSecret: process.env.AUTH_AUDIT_IP_HASH_SECRET ?? '',
  },
  storage: {
    driver: resolveStorageDriver(),
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? '',
    region: process.env.OBJECT_STORAGE_REGION ?? 'auto',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? '',
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY ?? '',
    publicBaseUrl: process.env.OBJECT_STORAGE_PUBLIC_BASE_URL,
  },
  transcode: {
    enabled: process.env.TRANSCODE_ENABLED === 'true',
    redisUrl: process.env.REDIS_URL,
    maxAttempts: parsePositiveIntEnv(
      process.env.TRANSCODE_MAX_ATTEMPTS,
      DEFAULT_TRANSCODE_MAX_ATTEMPTS,
    ),
    stalledAfterMinutes: parsePositiveIntEnv(
      process.env.TRANSCODE_STALLED_AFTER_MINUTES,
      DEFAULT_TRANSCODE_STALLED_AFTER_MINUTES,
    ),
    cleanupGraceMinutes: parsePositiveIntEnv(
      process.env.TRANSCODE_CLEANUP_GRACE_MINUTES,
      DEFAULT_TRANSCODE_CLEANUP_GRACE_MINUTES,
    ),
    workerConcurrency: parsePositiveIntEnv(
      process.env.TRANSCODE_WORKER_CONCURRENCY,
      DEFAULT_TRANSCODE_WORKER_CONCURRENCY,
    ),
    tempDir: normalizeOptionalEnv(process.env.TRANSCODE_TEMP_DIR),
    tempSweepMinAgeMinutes: parsePositiveIntEnv(
      process.env.TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES,
      DEFAULT_TRANSCODE_TEMP_SWEEP_MIN_AGE_MINUTES,
    ),
  },
  hlsGateway: {
    baseUrl: process.env.HLS_GATEWAY_BASE_URL,
    tokenSecret: process.env.HLS_TOKEN_SECRET,
    ttlSeconds: parsePositiveIntEnv(
      process.env.HLS_TOKEN_TTL_SECONDS,
      DEFAULT_HLS_TOKEN_TTL_SECONDS,
    ),
  },
  payments: {
    enabled: process.env.PAYMENTS_ENABLED === 'true',
    midtransServerKey: process.env.MIDTRANS_SERVER_KEY,
    midtransIsProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  },
  rewards: {
    enabled: process.env.REWARDS_ENABLED === 'true',
    timezone: process.env.REWARDS_TIMEZONE ?? DEFAULT_REWARDS_TIMEZONE,
  },
  content: {
    accessMode: resolveContentAccessMode(),
  },
  identityProviders: {
    googleEnabled: process.env.GOOGLE_AUTH_ENABLED === 'true',
    googleClientIds: parseCsvEnv(process.env.GOOGLE_OAUTH_CLIENT_IDS),
    whatsappEnabled: process.env.WHATSAPP_AUTH_ENABLED === 'true',
    whatsappOtpDriver: process.env.WHATSAPP_OTP_PROVIDER_DRIVER,
    whatsappCloudApiPhoneNumberId:
      process.env.WHATSAPP_CLOUD_API_PHONE_NUMBER_ID,
    whatsappCloudApiAccessToken: process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN,
    whatsappCloudApiTemplateName: process.env.WHATSAPP_CLOUD_API_TEMPLATE_NAME,
    whatsappCloudApiTemplateLanguage:
      process.env.WHATSAPP_CLOUD_API_TEMPLATE_LANGUAGE,
    whatsappCloudApiGraphVersion: process.env.WHATSAPP_CLOUD_API_GRAPH_VERSION,
    // Defaults ON — see `IdentityProvidersConfig` for why this one flag is
    // parsed as `!== 'false'` rather than the fail-closed `=== 'true'`.
    whatsappCloudApiTemplateHasOtpButton:
      process.env.WHATSAPP_CLOUD_API_TEMPLATE_HAS_OTP_BUTTON !== 'false',
  },
});

/**
 * PHASE 10B: splits a comma-separated env value into trimmed, non-empty
 * entries — the exact shape `app.corsOrigins` above already uses for
 * `CORS_ORIGINS`, reused rather than reinvented. An absent or blank value
 * yields an empty array, which `env.validation.ts` treats as "not
 * configured" when the corresponding feature flag is on, and which
 * `validateGoogleClaims` independently treats as "matches nothing".
 */
function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Slice 11P: permissive parse — an absent/blank value falls back to
 * `fallback` silently (the common, flag-off case), and the same fallback is
 * used for a present-but-invalid value too. This factory is deliberately NOT
 * where an invalid value fails boot — `env.validation.ts`'s
 * `validateTranscodeConfig` is (and only when `TRANSCODE_ENABLED=true`),
 * matching `resolveStorageDriver`'s existing "validate elsewhere, resolve
 * permissively here" split immediately below.
 */
function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Phase 11, work unit 11G-3: resolves `STORAGE_DRIVER` unset/empty/`local`
 * to `local` (the default). `env.validation.ts` runs before this factory
 * (see `ConfigModule.forRoot`'s `validate` option in `app.module.ts`) and
 * already fails the app's boot for any value other than `local`/`r2`, so by
 * the time this runs the only other possible value is the literal `r2`.
 */
/**
 * PRODUCTION HTTPS READINESS: the `parsePositiveIntEnv` sibling for a value
 * whose ZERO is meaningful rather than a mistake. `TRUST_PROXY_HOPS=0` is
 * the explicit "there is no proxy in front of me" answer, so it must survive
 * parsing instead of being rejected as non-positive and silently replaced by
 * a fallback. Same "validate elsewhere, resolve permissively here" split
 * every other parser in this file follows — `env.validation.ts` has already
 * failed the boot for a malformed value by the time this runs.
 */
/**
 * Normalizes an OPTIONAL free-form env value: an unset OR
 * whitespace-only variable both resolve to `undefined`, never `''`.
 *
 * Mirrors `StorageConfig.publicBaseUrl`/`HlsGatewayConfig.baseUrl`'s existing
 * "never default a genuinely absent value to an empty string" rule — an `''`
 * path would silently become the process's working directory rather than
 * falling back to the documented default.
 */
function normalizeOptionalEnv(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseNonNegativeIntEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveStorageDriver(): StorageDriver {
  return process.env.STORAGE_DRIVER === 'r2' ? 'r2' : DEFAULT_STORAGE_DRIVER;
}

/**
 * Work unit "V1 FREE ACCESS POLICY": resolves `CONTENT_ACCESS_MODE`
 * unset/empty/`entitlement` to `entitlement` (the default). Same
 * "validate elsewhere, resolve permissively here" split as
 * `resolveStorageDriver` directly above — `env.validation.ts`'s
 * `validateContentAccessMode` runs before this factory (see
 * `ConfigModule.forRoot`'s `validate` option in `app.module.ts`) and has
 * already failed the boot for any value other than the two known modes, so
 * by the time this runs the only other possible value is the literal
 * `free`.
 */
function resolveContentAccessMode(): ContentAccessMode {
  return process.env.CONTENT_ACCESS_MODE === 'free'
    ? 'free'
    : DEFAULT_CONTENT_ACCESS_MODE;
}
