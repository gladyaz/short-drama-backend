import { Injectable, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import {
  AppConfig,
  HlsGatewayConfig,
  RootConfig,
} from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
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
import { HlsRenditionSummary } from '../transcode/transcode.types';
import {
  HlsPlaybackResponseDto,
  HlsRenditionPlaybackDto,
  VideoPlaybackResponseDto,
  VideoRecord,
  VideoResponseDto,
} from './video.types';
import { resolveSafeStoragePath } from './storage-path.util';
import { resolvePlaybackSource } from './playback-source.util';

export interface StreamableVideo {
  record: VideoRecord;
  absolutePath: string;
  fileSize: number;
}

@Injectable()
export class VideosService {
  private readonly appConfig: AppConfig;
  private readonly hlsGatewayConfig: HlsGatewayConfig;

  constructor(
    private readonly configService: ConfigService<RootConfig>,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {
    this.appConfig = this.configService.get('app', { infer: true })!;
    this.hlsGatewayConfig = this.configService.get('hlsGateway', {
      infer: true,
    })!;
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
    const records = await this.prisma.video.findMany({
      where: {
        lifecycleState: MediaLifecycleState.PUBLISHED,
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
  async getStreamGuardInfo(
    id: string,
  ): Promise<{ episodeNumber: number; accessTierOverride: string | null }> {
    const record = await this.findPublishedRow(id);
    return {
      episodeNumber: record.episodeNumber,
      accessTierOverride: record.accessTierOverride,
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
      return hlsResponse;
    }

    const source = resolvePlaybackSource(record);

    if (source.kind === 'local') {
      return {
        playbackUrl: `${this.appConfig.publicBaseUrl}/videos/${id}/stream`,
        expiresAt: new Date(
          Date.now() + PLAYBACK_URL_EXPIRY_SECONDS * 1000,
        ).toISOString(),
        requiresAuthHeader: true,
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
   * Prisma's generated `Video` type represents nullable optional columns as
   * `T | null`, whereas `VideoRecord` (used across the rest of the app,
   * including `videos.data.ts`) represents them as `T | undefined`. This
   * normalizes the DB row into the app-level shape without changing any
   * value that was actually present.
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
  }): VideoRecord {
    return {
      ...record,
      durationSeconds: record.durationSeconds ?? undefined,
      width: record.width ?? undefined,
      height: record.height ?? undefined,
      // The column is a plain string at rest (see the schema comment), so it
      // is narrowed here, at the one boundary where DB rows become app
      // records. Anything unrecognised is treated as ordinary catalog
      // content: a row is only ever WITHHELD from a consumer catalog on an
      // explicit `qa_fixture`, never on a value we failed to parse.
      contentKind: toVideoContentKind(record.contentKind),
    };
  }

  private toResponseDto(record: VideoRecord): VideoResponseDto {
    return {
      id: record.id,
      seriesId: record.seriesId,
      title: record.title,
      episodeNumber: record.episodeNumber,
      channelName: record.channelName,
      caption: record.caption,
      category: record.category,
      storageKey: record.storageKey,
      playbackUrl: `${this.appConfig.publicBaseUrl}/videos/${record.id}/stream`,
      sourceLanguage: record.sourceLanguage,
      hasEmbeddedIndonesianSubtitle: record.hasEmbeddedIndonesianSubtitle,
      likeCount: record.likeCount,
      durationSeconds: record.durationSeconds,
      width: record.width,
      height: record.height,
      contentKind: record.contentKind,
    };
  }
}

/**
 * Narrows the persisted `Video.contentKind` string to the enum.
 *
 * Deliberately fail-OPEN: an unknown value becomes `DRAMA`. The alternative
 * (defaulting to `QA_FIXTURE`) would let a typo or a future third kind
 * silently erase real content from every consumer catalog, which is a far
 * worse failure than a fixture briefly showing up.
 */
const contentKindLogger = new Logger('VideoContentKind');

function toVideoContentKind(value: string): VideoContentKind {
  if (
    value !== (VideoContentKind.DRAMA as string) &&
    value !== (VideoContentKind.QA_FIXTURE as string)
  ) {
    // Fail-open is deliberate (see below) but must not be SILENT: an
    // unrecognised value means a write path invented a kind this build does
    // not know, and it will be reported to clients as ordinary content.
    contentKindLogger.warn(
      `Unrecognised Video.contentKind ${JSON.stringify(value)}; treating as ` +
        `${VideoContentKind.DRAMA}. Add it to VideoContentKind and toVideoContentKind.`,
    );
  }

  // `as string` matches the existing `MediaLifecycleState.PUBLISHED` cast
  // above: the column is a plain string at rest, so comparing it to an enum
  // member is exactly the widening this codebase already does at that
  // boundary.
  return value === (VideoContentKind.QA_FIXTURE as string)
    ? VideoContentKind.QA_FIXTURE
    : VideoContentKind.DRAMA;
}

/**
 * Slice 11Q: `Video.hlsRenditions` is a Prisma `Json?` column — at the type
 * level it comes back as `Prisma.JsonValue` (effectively `unknown` for our
 * purposes), which could in principle be `null`, a non-array value, or an
 * array containing malformed entries if ever hand-edited. This is a
 * defensive, non-throwing parser: anything that is not EXACTLY an array of
 * well-formed `HlsRenditionSummary`-shaped objects is filtered out (an
 * entirely malformed value yields an empty array, never a thrown error and
 * never a partially-trusted entry) — `VideosService` never trusts this
 * column's shape implicitly, even though the ONLY writer today
 * (`TranscodeIntentService.promoteIfCurrent`, Slice 11P) always writes a
 * well-formed array.
 */
function parseHlsRenditions(value: unknown): HlsRenditionSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isHlsRenditionSummary);
}

function isHlsRenditionSummary(value: unknown): value is HlsRenditionSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.bandwidth === 'number'
  );
}
