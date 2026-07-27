import { minutes, seconds } from '@nestjs/throttler';

/**
 * Phase 12, work unit 12A-B1: named-constant IP request-throttle
 * configuration for `ThrottlerModule` (see DECISIONS.md "Phase 12 ...
 * approved..." entry, decision 4). Centralized here (not inline in
 * `app.module.ts`/`auth.controller.ts`) per `common/coding-style.md`
 * ("no hardcoded values" — magic numbers get named constants).
 *
 * This is coarse, in-memory, per-`Nest` application-instance IP throttling
 * — a shared/persistent IP-rate store across multiple backend instances is
 * explicitly deferred to Phase 13 (decision 4). It is a SEPARATE mechanism
 * from the persistent PostgreSQL account-lockout constants in
 * `src/auth/auth.constants.ts`, which survives restarts and is keyed to the
 * account, not the IP.
 */

/**
 * Generous default limit applied to every route that has NOT been given a
 * tighter `@Throttle()` override (i.e. everything except
 * `/auth/login|register|refresh`). Deliberately high enough that no
 * existing/legitimate test or real client traffic pattern in this app comes
 * close to tripping it — it exists purely as coarse abuse protection, not as
 * a meaningful per-route limit (see `LOGIN_RATE_LIMIT`/`REGISTER_RATE_LIMIT`/
 * `REFRESH_RATE_LIMIT` below for the routes that actually need a strict
 * limit).
 */
export const DEFAULT_THROTTLE_LIMIT = 300;
export const DEFAULT_THROTTLE_TTL_MS = seconds(60);

/** `POST /auth/login`: 5 requests per minute per IP (decision 4). */
export const LOGIN_RATE_LIMIT = 5;
export const LOGIN_RATE_TTL_MS = seconds(60);

/** `POST /auth/register`: 3 requests per 10 minutes per IP (decision 4). */
export const REGISTER_RATE_LIMIT = 3;
export const REGISTER_RATE_TTL_MS = minutes(10);

/** `POST /auth/refresh`: 30 requests per minute per IP (decision 4). */
export const REFRESH_RATE_LIMIT = 30;
export const REFRESH_RATE_TTL_MS = seconds(60);
