import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { OptionalCurrentUser } from '../auth/decorators/optional-current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  VIDEO_PLAYBACK_URL_RATE_LIMIT,
  VIDEO_PLAYBACK_URL_RATE_TTL_MS,
  VIDEO_STREAM_RATE_LIMIT,
  VIDEO_STREAM_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { FREE_EPISODE_LIMIT } from '../entitlements/entitlement.constants';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { VideosService } from './videos.service';
import type {
  HlsPlaybackResponseDto,
  VideoPlaybackResponseDto,
  VideoResponseDto,
} from './video.types';
import { parseRangeHeader } from './video-range.util';

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  @Get('feed')
  getFeed(): Promise<VideoResponseDto[]> {
    return this.videosService.findAll();
  }

  /**
   * Phase 10, work unit 10-B3: previously this route had no guard at all —
   * any client with a video id could stream the file directly, bypassing
   * whatever premium gate the mobile UI showed. `JwtAuthGuard` now requires
   * a valid access token for every stream request (see DECISIONS.md "Phase
   * 10 approved..." entry, default decision 1), and the entitlement check
   * below runs before `resolveStreamableFile()` touches the filesystem, so a
   * denied request never opens a file handle for a video it isn't allowed
   * to read.
   *
   * Phase 11, work unit 11E-3: the premium/free decision itself now goes
   * through `EntitlementsService.resolveEpisodePremium`, which honors a
   * per-episode `accessTierOverride` (set via the admin-guarded
   * `PATCH /admin/media/:id/access-tier`) when one is set, and otherwise
   * falls back UNCHANGED to the original `episodeNumber >
   * FREE_EPISODE_LIMIT` rule — every one of the 40 pre-existing rows has no
   * override, so this is behavior-preserving for them.
   *
   * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": the guard changes from
   * `JwtAuthGuard` to `OptionalJwtAuthGuard`, so a signed-out guest can
   * reach this route WITHOUT a token — but the authorization decision
   * itself is unchanged and still runs, for every caller, through the same
   * `enforceEntitlementGate` below. A guest is simply a caller with no
   * entitlement: FREE (by authoritative `accessTier`) plays, PREMIUM is
   * denied with the identical `403 ENTITLEMENT_REQUIRED` a signed-in
   * non-entitled caller gets. A SUPPLIED but invalid/expired/malformed
   * token still fails with `401 INVALID_ACCESS_TOKEN` and never falls back
   * to guest — see `OptionalJwtAuthGuard`'s doc comment. This route is the
   * media-bytes endpoint for LOCAL-storage rows, so without this change a
   * guest could be authorized at `/playback` and still be unable to fetch a
   * single byte.
   *
   * The `@Throttle` override (fix cycle 1, Reviewer A MEDIUM finding) closes
   * the gap left by that guard swap: `/playback` already had a dedicated
   * ceiling, while this route — the one that actually does filesystem I/O
   * and can stream a whole episode per request — was still inheriting the
   * generous 300/min app-wide default. See `VIDEO_STREAM_RATE_LIMIT`'s doc
   * comment for why it is 120 rather than `/playback`'s 60 (a media player
   * legitimately issues many requests per episode) and for what this does
   * NOT protect against.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({
    default: {
      limit: VIDEO_STREAM_RATE_LIMIT,
      ttl: VIDEO_STREAM_RATE_TTL_MS,
    },
  })
  @Get(':id/stream')
  async streamVideo(
    @Param('id') id: string,
    @OptionalCurrentUser() user: AuthenticatedUser | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.enforceEntitlementGate(id, user);

    const { absolutePath, fileSize } =
      await this.videosService.resolveStreamableFile(id);
    const range = parseRangeHeader(req.headers.range, fileSize);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');

    const start = range?.start ?? 0;
    const end = range?.end ?? fileSize - 1;
    const stream = createReadStream(absolutePath, { start, end });
    req.on('close', () => stream.destroy());

    if (range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
    } else {
      res.status(HttpStatus.OK);
      res.setHeader('Content-Length', fileSize);
    }

    stream.pipe(res);
  }

  /**
   * Phase 11, work unit 11M-B4 (DECISIONS.md "Slice 11M approved..." entry,
   * Option A). Answers for BOTH storage kinds — R2-backed media gets a
   * short-lived presigned GET URL (`requiresAuthHeader: false`); local-backed
   * media gets its existing `/videos/:id/stream` URL (`requiresAuthHeader:
   * true`, still gated by `JwtAuthGuard` + the entitlement check on every
   * request there) — so the mobile client keeps ONE code path and learns
   * nothing about which backend served a given video.
   *
   * ⚠️ Applies the EXACT SAME `enforceEntitlementGate` call `streamVideo`
   * uses above, not a separate/parallel implementation: without this, a
   * non-entitled user could bypass the premium paywall entirely by asking
   * for a playback URL instead of a stream (see DECISIONS.md's
   * "load-bearing discovery" paragraph — this is the single highest-risk
   * property of this slice).
   *
   * `@Throttle()` override (independent review addendum, 2026-08-08): see
   * `VIDEO_PLAYBACK_URL_RATE_LIMIT`'s doc comment in
   * `common/rate-limit.constants.ts` for why this route does not rely on
   * the generous app-wide default — it mints a directly-shareable,
   * auth-free presigned URL for R2-backed media, the same class of risk
   * `ADMIN_MEDIA_UPLOAD_INITIATE_RATE_LIMIT` already exists to bound for
   * the PUT-minting route.
   *
   * Slice 11Q (control-workspace DECISIONS.md "2026-08-10 — Slice 11Q
   * APPROVED..." entry): SAME route, SAME auth/entitlement gate above — no
   * parallel auth system. `VideosService.getPlaybackUrl` now ALSO checks,
   * before its existing R2/local resolution, whether the row is a fully
   * `processingState: 'ready'` HLS-pipeline row; if so it returns the
   * separate `HlsPlaybackResponseDto` shape (`{type:'hls', masterUrl,
   * renditions, expiresAt}`, one short-lived gateway token covering the
   * master playlist and every actually-produced rendition) instead of the
   * legacy `VideoPlaybackResponseDto` shape. Every non-HLS row's response
   * is byte-identical to before this slice.
   *
   * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": same guard swap as
   * `/stream` above, for the same reason and with the same single shared
   * gate — `OptionalJwtAuthGuard` lets a signed-out guest ASK, and
   * `enforceEntitlementGate` (unchanged) decides. The `@Throttle` override
   * matters more, not less, now that this route is reachable without a
   * session: `ThrottlerGuard` is keyed per-IP, so the same
   * `VIDEO_PLAYBACK_URL_RATE_LIMIT` ceiling that already bounded
   * presigned-URL minting for authenticated callers bounds anonymous
   * callers identically.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({
    default: {
      limit: VIDEO_PLAYBACK_URL_RATE_LIMIT,
      ttl: VIDEO_PLAYBACK_URL_RATE_TTL_MS,
    },
  })
  @Get(':id/playback')
  async getPlaybackUrl(
    @Param('id') id: string,
    @OptionalCurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<VideoPlaybackResponseDto | HlsPlaybackResponseDto> {
    await this.enforceEntitlementGate(id, user);
    return this.videosService.getPlaybackUrl(id);
  }

  @Get(':id')
  getById(@Param('id') id: string): Promise<VideoResponseDto> {
    return this.videosService.findById(id);
  }

  /**
   * Phase 11, work unit 11M-B2: extracted, behavior-preserving, from what
   * used to be `streamVideo`'s own inline check — now the SINGLE place both
   * `streamVideo` and `getPlaybackUrl` run the "not found" / "not
   * published" / "premium episode, not entitled" gate through, so the two
   * routes can never drift apart on who is allowed to play a given episode.
   * Throws `VIDEO_NOT_FOUND` (via `getStreamGuardInfo`) for a
   * nonexistent/non-published id, or `ENTITLEMENT_REQUIRED` for a
   * not-entitled caller on a premium episode; returns normally (void) once
   * the caller is allowed to proceed.
   *
   * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": `user` became optional.
   * This is the ONLY function that decides guest access, and it decides it
   * the same way it decides everyone else's — by the content's
   * authoritative effective access tier first, entitlement second. There is
   * no guest-specific branch, no bypass flag, and no second code path.
   *
   * The `VIDEO_NOT_FOUND` ordering is deliberate and unchanged: a guest now
   * learns 404-vs-403 for an id where they previously got a blanket 401.
   * That is not new information — `GET /videos/:id` and `GET /videos/feed`
   * are already fully public and expose exactly the same published-row set.
   */
  private async enforceEntitlementGate(
    id: string,
    user: AuthenticatedUser | undefined,
  ): Promise<void> {
    const guardInfo = await this.videosService.getStreamGuardInfo(id);

    // The authoritative effective tier — an admin `accessTierOverride` when
    // one is set, the existing default rule otherwise. Resolved through the
    // SAME `resolveEpisodePremium`/`resolveAccessTier` pair the public
    // `VideoResponseDto.accessTier` field and `hasPremiumEpisodes` are built
    // from, so no caller can be told a tier this gate then disagrees with.
    // NOTHING here reads `episodeNumber` directly.
    if (
      !this.entitlementsService.resolveEpisodePremium(
        guardInfo,
        FREE_EPISODE_LIMIT,
      )
    ) {
      // FREE. Allowed for EVERY caller — guest or signed-in, entitled or
      // not. This single line is the whole product change: a guest is no
      // longer refused before the tier is even looked at.
      return;
    }

    // PREMIUM from here down. A guest cannot hold an entitlement, so the
    // `isEntitled` lookup is skipped entirely rather than being called with
    // a fabricated id — but the OUTCOME is deliberately identical to a
    // signed-in caller who has no entitlement: the same code, the same
    // status, the same message, byte for byte. A caller therefore cannot
    // use this response to learn whether their token was recognized, and
    // the client needs no new error contract to handle guests.
    if (user && (await this.entitlementsService.isEntitled(user.id))) {
      return;
    }

    throw new AppException(
      AppErrorCode.ENTITLEMENT_REQUIRED,
      'An active entitlement is required to stream this episode',
      HttpStatus.FORBIDDEN,
    );
  }
}
