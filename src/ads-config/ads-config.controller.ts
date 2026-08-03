import { Controller, Get } from '@nestjs/common';
import { AdsConfigService } from './ads-config.service';
import type { AdsConfig } from './ads-config.types';

/**
 * Phase 15A, slice 15A-S1 (control workspace `DECISIONS.md`, "2026-08-03 —
 * Phase 15A slice S1 APPROVED...", commit `0f75033`).
 *
 * `GET /config/ads` — deliberately PUBLIC (no auth guard) and UNENVELOPED
 * (the frozen contract is the exact top-level five-field object, not the
 * `{ success, data, error }` API-response envelope pattern used elsewhere in
 * this codebase). The mobile app fetches this at launch, before any user is
 * signed in, so it cannot require a bearer token. Every field is a coarse,
 * non-secret tuning knob (a boolean and four small integers) — nothing
 * here is a credential, a path, or a value the "never leak a secret" rule
 * in `common/security.md`/`AGENT_RULES.md` is concerned with.
 *
 * Inherits the global `ThrottlerGuard`'s generous default limit
 * (`DEFAULT_THROTTLE_LIMIT`/`DEFAULT_THROTTLE_TTL_MS` in
 * `src/common/rate-limit.constants.ts`, wired as `APP_GUARD` in
 * `app.module.ts`) — no per-route `@Throttle()` override is needed for a
 * cheap, static, in-memory-computed GET like this one.
 */
@Controller('config')
export class AdsConfigController {
  constructor(private readonly adsConfigService: AdsConfigService) {}

  @Get('ads')
  getAdsConfig(): AdsConfig {
    return this.adsConfigService.getConfig();
  }
}
