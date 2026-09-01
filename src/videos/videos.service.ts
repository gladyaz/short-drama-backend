import { Injectable, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import {
  AppConfig,
  ContentAccessMode,
  HlsGatewayConfig,
  RootConfig,
} from '../config/configuration';
import { readContentAccessMode } from '../config/content-access-mode.util';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  FREE_EPISODE_LIMIT,
  resolveAccessTier,
} from '../entitlements/entitlement.constants';
import { MediaLifecycleState } from '../media/media-lifecycle.types';
import { VideoContentKind } from './video-content-kind.types';
import { PrismaService } from '../prisma/prisma.service';
import { PLAYBACK_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  derivePrefixFromMasterKey,
  mintHlsToken,
} from '../transcode/hls/hls-playback-token.util';
import {
  HLS_MASTER_PLAYLIST_FILENAME,
  HLS_VARIANT_PLAYLIST_FILENAME,
} from '../transcode/hls/hls.constants';
import { parseHlsRenditions } from '../transcode/hls-rendition-summary.util';
import {
  HlsPlaybackResponseDto,
  HlsRenditionPlaybackDto,
  Mp4PlaybackFallbackDto,
  VideoPlaybackResponseDto,
  VideoRecord,
  VideoResponseDto,
} from './video.types';
import { redactSensitiveText } from '../common/logging/redact';
import { resolveSafeStoragePath } from './storage-path.util';
import { resolvePlaybackSource } from './playback-source.util';
import { toVideoRecord, toVideoResponseDto } from './video-response.util';

export interface StreamableVideo {
  record: VideoRecord;
  absolutePath: string;
  fileSize: number;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);
  private readonly appConfig: AppConfig;
  private readonly hlsGatewayConfig: HlsGatewayConfig;
  /**
   * Work unit "V1 FREE ACCESS POLICY": read once at construction through the
   * shared `readContentAccessMode` helper, exactly like the two configs
   * above. Feeds BOTH tier-dependent answers this service produces — the
   * public `VideoResponseDto.accessTier` (via `toResponseDto`) and
   * `VideoPlaybackResponseDto.requiresAuthHeader` — from the same value, so
   * neither can contradict the gate's decision in `VideosController`.
   */
  private readonly contentAccessMode: ContentAccessMode;

  constructor(
    private readonly configService: ConfigService<RootConfig>,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {
    this.appConfig = this.configService.get('app', { infer: true })!;
    this.hlsGatewayConfig = this.configService.get('hlsGateway', {
      infer: true,
    })!;
    this.contentAccessMode = readContentAccessMode(this.configService);
  }

  async findAll(): Promise<VideoResponseDto[]> {
    // Explicit, deterministic ordering (work unit 8-B4 fix cycle 1): without
    // an `orderBy`, SQLite happens to satisfy this query via the primary-key
    // index (alphabetical by `id`), which silently changed the feed's
    // starting video after the Prisma migration. `sortOrder` is a dedicated
    // column carrying the original curated order from `videos.data.ts`
    // (series-104 first) — `seriesId`/`episodeNumber` ordering does not
    // reproduce that order, since series are not curated alphabetically.
    //
    // `lifecycleState: PUBLISHED` (Phase 11, work unit 11B-3): the public
    // feed must never leak `draft`/`ready`/`unpublished`/`failed` rows
    // created by the admin media pipeline — those have no guarantee of a
    // real, streamable file yet. Every one of the 40 pre-existing rows
    // already defaults to `"published"` (11A-2's migration), so this is a
    // no-op for them and does not change `findAll`'s existing behavior.
    //
    // The `OR` (Phase 11, work unit 11G-1): closes a residual leak the
    // `lifecycleState` filter above does not cover — a row can be marked
    // `published` (e.g. by a future/partial admin flow) while still having
    // no playable source at all: an empty local `storageKey` (`""`, the
    // fallback used by non-file fixtures — see e.g.
    // `test/videos.e2e-spec.ts`'s `createOverrideFixture`) AND no
    // `objectStorageKey` (the R2/S3 pipeline column added in 11A-2, still
    // unused for real playback — see 11A-3/11B). A row is kept if EITHER
    // source is present; it is excluded only when both are absent. Every one
    // of the 40 pre-existing seed rows has a non-empty `storageKey`, so this
    // is a no-op for them and does not change `findAll`'s existing behavior.
    // V1 INTEGRATION FIX: exclude QA fixtures from the consumer feed.
    //
    // `GET /series` and `GET /series/:id` have filtered
    // `contentKind: DRAMA` since the "explicit contentKind" work unit, but
    // this feed never did — so the four `qa_fixture` rows
    // (`series-hlsproof`, `series-11rqa`, the `7` fixture) reached ordinary
    // viewers as if they were episodes. They are real, published and
    // streamable by design, which is exactly why they are indistinguishable
    // from catalog content once they are in the list.
    //
    // APPLIED IN THE QUERY, NOT AFTER IT. Filtering the returned array would
    // be correct only while this route returns everything; the moment a
    // `take`/`skip` is added, a post-filter silently shrinks pages below
    // their requested size and shifts every subsequent offset. Putting the
    // rule in the `where` makes the page size mean what it says.
    //
    // SCOPE IS LISTINGS ONLY, deliberately. `GET /videos/:id`,
    // `/videos/:id/playback` and `/videos/:id/stream` are direct-addressing
    // routes that still serve fixtures, because `scripts/hls-real-media-proof.ts`
    // seeds `media-hlsproof-*` rows and exercises `/videos/:id/playback`
    // against them to prove the gateway, and `hls:demote` reasons about the
    // same route. Hiding a row you must already know the id of buys nothing
    // and would break proven QA tooling.
    const records = await this.prisma.video.findMany({
      where: {
        lifecycleState: MediaLifecycleState.PUBLISHED,
        contentKind: VideoContentKind.DRAMA,
        OR: [{ storageKey: { not: '' } }, { objectStorageKey: { not: null } }],
      },
      orderBy: { sortOrder: 'asc' },
    });
    return records.map((record) =>
      this.toResponseDto(this.toVideoRecord(record)),
    );
  }

  async findById(id: string): Promise<VideoResponseDto> {
    return this.toResponseDto(await this.findRecordById(id));
  }

  async resolveStreamableFile(id: string): Promise<StreamableVideo> {
    const record = await this.findRecordById(id);
    const absolutePath = resolveSafeStoragePath(
      this.appConfig.storageRoot,
      record.storageKey,
    );

    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'Media file not found on storage',
        HttpStatus.NOT_FOUND,
      );
    }

    const { size: fileSize } = statSync(absolutePath);
    return { record, absolutePath, fileSize };
  }

  /**
   * Work unit 11E-3: the minimal lookup `VideosController#streamVideo` uses
   * to resolve the premium/free decision for `id`, before any entitlement
   * check or filesystem access. Deliberately returns only `episodeNumber`
   * and `accessTierOverride` — NOT the full `VideoRecord`/`VideoResponseDto`
   * — since `accessTierOverride` must never reach the public API surface
   * (see `AdminMediaDto` in `src/media/media.types.ts` for its only intended
   * external exposure). Applies the same "not published -> VIDEO_NOT_FOUND"
   * rule as `findById`/`resolveStreamableFile` (via the shared
   * `findPublishedRow` helper), so an unpublished/nonexistent id behaves
   * identically at this stage of the stream pipeline too.
   */
  async getStreamGuardInfo(id: string): Promise<StreamGuardInfo> {
    const record = await this.findPublishedRow(id);
    return {
      episodeNumber: record.episodeNumber,
      accessTierOverride: record.accessTierOverride,
      // Work unit "REWARDS V1 EARN AND SPEND": carried so the caller can
      // record WHICH series a watch credit belongs to without a second
      // lookup. The row is already loaded; the entitlement decision below
      // still reads only `episodeNumber` and `accessTierOverride`, so no
      // access rule gains a new input from this field.
      seriesId: record.seriesId,
    };
  }

  /**
   * Phase 11, work unit 11M-B3/B4: resolves `GET /videos/:id/playback`'s
   * response body (DECISIONS.md "Slice 11M approved..." entry, Option A).
   *
   * Callers MUST apply the same premium-entitlement gate `streamVideo` uses
   * BEFORE calling this method — this method itself only re-runs the
   * shared "must exist and be published" check (via `findPublishedRow`,
   * identical to `findById`/`resolveStreamableFile`), never an entitlement
   * check on its own. See `VideosController#enforceEntitlementGate`, the
   * single place both routes now share that check through.
   *
   * The storage-kind decision itself is delegated entirely to
   * `resolvePlaybackSource` (work unit 11M-B1) — this method never inlines
   * that rule. The object key handed to `createPresignedGetUrl` always
   * comes from the freshly-loaded `record.objectStorageKey`, never from any
   * request-supplied value (this method takes only `id`). The resulting
   * URL/expiry is computed fresh on every call and is never persisted
   * anywhere, per the DECISIONS.md contract.
   */
  async getPlaybackUrl(
    id: string,
  ): Promise<VideoPlaybackResponseDto | HlsPlaybackResponseDto> {
    const record = await this.findPublishedRow(id);

    const hlsResponse = this.tryBuildHlsPlaybackResponse(record);
    if (hlsResponse) {
      // Work unit "HLS MP4 FALLBACK": HLS stays the PREFERRED source and is
      // returned whether or not a fallback could be built — `tryBuildMp4Fallback`
      // resolves to `undefined` rather than throwing, so nothing about the
      // HLS branch's success depends on the MP4 branch working.
      const fallback = await this.tryBuildMp4Fallback(record);
      return fallback ? { ...hlsResponse, fallback } : hlsResponse;
    }

    return this.buildMp4Playback(record);
  }

  /**
   * Work unit "HLS MP4 FALLBACK": THE one place a progressive-MP4 playback
   * response is built, for BOTH the legacy (non-HLS) branch of
   * `getPlaybackUrl` and the `fallback` field of an HLS response.
   *
   * Extracted verbatim from `getPlaybackUrl`'s former inline body — every
   * rule below (R2-wins precedence via `resolvePlaybackSource`, the
   * content-derived `requiresAuthHeader`, the synthetic-vs-real `expiresAt`)
   * is unchanged, and a non-HLS row's response is byte-identical to what it
   * was before the extraction. That identity is the point: the MP4 URL an
   * HLS-ready row falls back to is produced by the same code, from the same
   * row, as the MP4 URL it served before it was transcoded, so the two can
   * never disagree.
   */
  private async buildMp4Playback(record: {
    id: string;
    storageKey: string;
    objectStorageKey: string | null;
    accessTierOverride: string | null;
    episodeNumber: number;
  }): Promise<VideoPlaybackResponseDto> {
    const id = record.id;
    const source = resolvePlaybackSource(record);

    if (source.kind === 'local') {
      return {
        playbackUrl: `${this.appConfig.publicBaseUrl}/videos/${id}/stream`,
        expiresAt: new Date(
          Date.now() + PLAYBACK_URL_EXPIRY_SECONDS * 1000,
        ).toISOString(),
        // Work unit "ANONYMOUS FREE-EPISODE PLAYBACK": was hardcoded `true`.
        // It is now DERIVED from this row's authoritative effective access
        // tier, because that hardcoded `true` became a lie the moment
        // `/videos/:id/stream` accepted anonymous callers for free content:
        // a guest told `requiresAuthHeader: true` has no token to attach and
        // would either send `Bearer undefined` or give up, so `/playback`
        // would answer 200 for a source the guest still cannot fetch — the
        // exact "authorized but no bytes" failure this work unit exists to
        // prevent.
        //
        // Resolved through the SAME `resolveAccessTier` the gate
        // (`VideosController#enforceEntitlementGate`, via
        // `resolveEpisodePremium`) and the public `VideoResponseDto
        // .accessTier` field already use, from the SAME row this method
        // already loaded — so this flag can never contradict the
        // authorization decision `/stream` will actually make.
        //
        // Deliberately a function of the CONTENT only, never of the caller:
        // the same row yields the same value for a guest, a signed-in
        // non-entitled user, and a Premium subscriber. It leaks nothing
        // about who asked, and stays cacheable/uniform per video.
        //   free    -> false: `/stream` serves this row to anyone, so no
        //              header is REQUIRED. A client that attaches a valid
        //              token anyway is still accepted.
        //   premium -> true: `/stream` still refuses this row without an
        //              active entitlement, exactly as before.
        requiresAuthHeader:
          resolveAccessTier(
            {
              accessTierOverride: record.accessTierOverride,
              episodeNumber: record.episodeNumber,
            },
            FREE_EPISODE_LIMIT,
            this.contentAccessMode,
          ) === 'premium',
      };
    }

    const signed = await this.storageService.createPresignedGetUrl(
      source.objectStorageKey,
      { expiresInSeconds: PLAYBACK_URL_EXPIRY_SECONDS },
    );

    return {
      playbackUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      requiresAuthHeader: false,
    };
  }

  /**
   * Work unit "HLS MP4 FALLBACK": the same MP4 response as
   * `buildMp4Playback`, but as a BEST-EFFORT value for an HLS-ready row —
   * `undefined` instead of a throw whenever it cannot be produced.
   *
   * Two distinct things can go wrong, and both are non-fatal HERE
   * specifically because the caller already holds a working HLS response:
   *
   *  - the row genuinely has no non-HLS source. `resolvePlaybackSource`
   *    fails CLOSED by design (`MEDIA_PLAYBACK_SOURCE_UNAVAILABLE`), which
   *    is the right answer when it is the ONLY source being resolved, and
   *    the wrong one here: an HLS-ready row with no surviving MP4 is a row
   *    that plays perfectly over HLS. Reachable in practice — a future
   *    retention/cleanup pass that drops raw sources once a row is
   *    transcoded produces exactly this state.
   *  - presigning fails (a storage outage, an expired credential). Again
   *    the HLS branch is unaffected: the gateway reads R2 through its own
   *    Worker binding, not through these S3 credentials, so it keeps
   *    serving while this call is failing.
   *
   * In both cases the field is simply ABSENT. It is never emitted with a
   * placeholder, an empty string, or a URL this method could not verify it
   * had actually built — a client must be able to treat the field's
   * presence as a promise that there is something there to play.
   *
   * A genuinely unexpected error is still swallowed here, which is a
   * deliberate trade: this is an optional enrichment of an
   * already-successful response, and letting it fail the request would make
   * playback STRICTLY less reliable than before the field existed. It is
   * logged at `warn` so the condition is visible rather than silent.
   */
  private async tryBuildMp4Fallback(record: {
    id: string;
    storageKey: string;
    objectStorageKey: string | null;
    accessTierOverride: string | null;
    episodeNumber: number;
  }): Promise<Mp4PlaybackFallbackDto | undefined> {
    try {
      const { playbackUrl, expiresAt, requiresAuthHeader } =
        await this.buildMp4Playback(record);
      return { playbackUrl, expiresAt, requiresAuthHeader };
    } catch (error) {
      this.logger.warn(
        redactSensitiveText(
          `No MP4 fallback could be built for HLS-ready media "${record.id}"; ` +
            `serving HLS without one: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return undefined;
    }
  }

  /**
   * Slice 11Q: builds the HLS branch of `getPlaybackUrl`'s response, or
   * returns `null` when the row does not cleanly qualify — in which case
   * the caller falls through to the EXISTING (unchanged) R2/local
   * resolution below, exactly as it did before this slice. Deliberately
   * checked BEFORE `resolvePlaybackSource` runs at all: an HLS-ready row
   * still carries a `storageKey`/`objectStorageKey` from its original
   * upload (11B/11L), but once its HLS generation is `ready` that is the
   * canonical playback source, not the raw MP4.
   *
   * "Cleanly qualifies" requires ALL of:
   *  - `processingState === 'ready'` (Slice 11N/11P's own `ProcessingState`
   *    union — the double-guard the 2026-08-10 approval calls for: an
   *    unpublished/not-yet-processed row can never reach here at all
   *    because `findPublishedRow` already required `lifecycleState ===
   *    'published'`, and THIS check additionally requires the processing
   *    axis to be fully done);
   *  - a non-empty `hlsMasterKey`;
   *  - a prefix that `derivePrefixFromMasterKey` can cleanly derive AND
   *    that verifiably belongs to this row's own `id` (see that
   *    function's doc comment) — a malformed/mismatched key (which should
   *    be unreachable given 11P's own write-path guarantees) falls
   *    through to the legacy branch rather than throwing, since it is a
   *    data-integrity anomaly, not a configuration error.
   *
   * Only once a row cleanly qualifies does a MISSING gateway config
   * (`HLS_GATEWAY_BASE_URL`/`HLS_TOKEN_SECRET`) become a real, reportable
   * error (`HLS_GATEWAY_NOT_CONFIGURED`) rather than a silent fallback —
   * see this method's own doc comment above for why that state should be
   * unreachable in the real shipped default in the first place.
   */
  private tryBuildHlsPlaybackResponse(record: {
    id: string;
    processingState: string | null;
    hlsMasterKey: string | null;
    hlsRenditions: unknown;
  }): HlsPlaybackResponseDto | null {
    if (record.processingState !== 'ready' || !record.hlsMasterKey) {
      return null;
    }

    const prefix = derivePrefixFromMasterKey(record.id, record.hlsMasterKey);
    if (!prefix) {
      return null;
    }

    if (!this.hlsGatewayConfig.baseUrl || !this.hlsGatewayConfig.tokenSecret) {
      throw new AppException(
        AppErrorCode.HLS_GATEWAY_NOT_CONFIGURED,
        'The HLS delivery gateway is not configured (HLS_GATEWAY_BASE_URL/HLS_TOKEN_SECRET)',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const minted = mintHlsToken({
      mediaId: record.id,
      prefix,
      ttlSeconds: this.hlsGatewayConfig.ttlSeconds,
      secret: this.hlsGatewayConfig.tokenSecret,
    });

    const baseUrl = this.hlsGatewayConfig.baseUrl;
    const tokenPathPrefix = `${baseUrl}/t/${minted.token}`;

    const renditions: HlsRenditionPlaybackDto[] = parseHlsRenditions(
      record.hlsRenditions,
    ).map((rendition) => ({
      quality: rendition.name,
      width: rendition.width,
      height: rendition.height,
      url: `${tokenPathPrefix}/${rendition.name}/${HLS_VARIANT_PLAYLIST_FILENAME}`,
    }));

    return {
      type: 'hls',
      masterUrl: `${tokenPathPrefix}/${HLS_MASTER_PLAYLIST_FILENAME}`,
      renditions,
      expiresAt: minted.expiresAt,
    };
  }

  private async findRecordById(id: string): Promise<VideoRecord> {
    return this.toVideoRecord(await this.findPublishedRow(id));
  }

  /**
   * Shared by `findRecordById` (and transitively `findById`/
   * `resolveStreamableFile`) and `getStreamGuardInfo`: fetches the raw
   * Prisma row and enforces the existing "must be published" rule. A row
   * that exists but is not `published` (Phase 11, work unit 11B-3: a
   * draft/ready/unpublished/failed row from the admin media pipeline) is
   * treated identically to a nonexistent one — the same `VIDEO_NOT_FOUND`
   * outcome, deliberately not a distinct code, so a caller cannot use this
   * endpoint to enumerate unpublished ids.
   */
  private async findPublishedRow(id: string) {
    const record = await this.prisma.video.findUnique({ where: { id } });

    if (
      !record ||
      record.lifecycleState !== (MediaLifecycleState.PUBLISHED as string)
    ) {
      throw new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Video not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return record;
  }

  /**
   * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": delegates to
   * the extracted, shared `toVideoRecord` (`./video-response.util.ts`) —
   * behavior-preserving, byte-identical output to before this extraction.
   * See that file's doc comment for why it was pulled out (the new public
   * `GET /series/:id` reuses the exact same mapping for its embedded
   * episode objects).
   */
  private toVideoRecord(record: {
    id: string;
    seriesId: string;
    title: string;
    episodeNumber: number;
    channelName: string;
    caption: string;
    category: string;
    storageKey: string;
    sourceLanguage: string;
    hasEmbeddedIndonesianSubtitle: boolean;
    likeCount: number;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    contentKind: string;
    accessTierOverride: string | null;
  }): VideoRecord {
    return toVideoRecord(record);
  }

  private toResponseDto(record: VideoRecord): VideoResponseDto {
    return toVideoResponseDto(
      record,
      this.appConfig.publicBaseUrl,
      this.contentAccessMode,
    );
  }
}

/**
 * What `getStreamGuardInfo` hands the controller: everything needed to decide
 * access, plus the identifiers a reward watch credit records.
 */
export interface StreamGuardInfo {
  readonly episodeNumber: number;
  readonly accessTierOverride: string | null;
  readonly seriesId: string;
}
