import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig, RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { FREE_EPISODE_LIMIT } from '../entitlements/entitlement.constants';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MediaLifecycleState } from '../media/media-lifecycle.types';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_GET_URL_EXPIRY_SECONDS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { VideoContentKind } from '../videos/video-content-kind.types';
import {
  toVideoRecord,
  toVideoResponseDto,
} from '../videos/video-response.util';
import {
  SeriesDetailPublicDto,
  SeriesListResponseDto,
  SeriesPublicDto,
} from './series-public.types';

type SeriesRow = {
  id: string;
  title: string;
  coverImageKey: string | null;
  archivedAt: Date | null;
};

/**
 * The minimal shape `computeSeriesAggregate`/`toVideoRecord` actually read
 * off a raw `Video` row. Prisma's `findMany` result has more columns than
 * this (`objectStorageKey`, `processingState`, etc.) — TypeScript's
 * structural typing accepts that superset wherever this narrower shape is
 * expected, so no explicit `select` is needed to satisfy it.
 */
type VideoRow = {
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
};

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": the public,
 * UNAUTHENTICATED read surface for curated `Series` rows — `GET /series`
 * and `GET /series/:id` (`SeriesPublicController`). A wholly separate
 * service from the admin-guarded `SeriesService` (`./series.service.ts`,
 * unchanged by this work unit): that service's CRUD/archive/delete methods
 * are never called from here, and nothing here ever writes a `Series` or
 * `Video` row — every method is a read.
 *
 * "Qualifying episode" (used throughout this file) means a `Video` row
 * that is BOTH `lifecycleState: "published"` (the same rule
 * `VideosService#findAll` already applies to the public feed) AND
 * `contentKind: "drama"` (Phase 11, work unit "explicit contentKind
 * classification" — excludes the two known QA fixtures, and any future
 * fixture, from ever counting toward a public series's aggregates or
 * episode list). This is the mechanism that keeps a QA-fixture-only
 * `seriesId` (e.g. `series-11rqa`, whose sole `Video` row is
 * `contentKind: "qa_fixture"`) from ever leaking a public series: EVEN IF
 * a `Series` metadata row existed for it (none does — the backfill
 * migration only ever creates rows for the 4 real, verified series), it
 * would have zero qualifying episodes and would be excluded by the same
 * "no qualifying episodes -> not publicly visible" rule applied below to
 * `list`/`findById` alike.
 */
@Injectable()
export class PublicSeriesService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly entitlementsService: EntitlementsService,
    private readonly configService: ConfigService<RootConfig>,
  ) {
    this.appConfig = this.configService.get('app', { infer: true })!;
  }

  /**
   * `GET /series`: every active (`archivedAt: null`), non-empty curated
   * series, ordered the same way `GET /admin/series` already orders them
   * (`sortOrder` then `id`). "Non-empty" — a series with zero qualifying
   * episodes is silently omitted, not errored; see this class's own doc
   * comment for why that is the QA-fixture-exclusion mechanism, not a
   * separate special case.
   */
  async list(): Promise<SeriesListResponseDto> {
    const seriesRows = await this.prisma.series.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    if (seriesRows.length === 0) {
      return { items: [] };
    }

    const episodesBySeriesId = await this.loadQualifyingEpisodesBySeriesId(
      seriesRows.map((series) => series.id),
    );

    const withEpisodes = seriesRows
      .map((series) => ({
        series,
        episodes: episodesBySeriesId.get(series.id) ?? [],
      }))
      .filter(({ episodes }) => episodes.length > 0);

    const items = await Promise.all(
      withEpisodes.map(({ series, episodes }) =>
        this.toPublicDto(series, episodes),
      ),
    );

    return { items };
  }

  /**
   * `GET /series/:id`: canonical metadata plus every qualifying episode,
   * ordered by `episodeNumber` ascending (see `SeriesDetailPublicDto`'s doc
   * comment for why that differs from `GET /videos/feed`'s `sortOrder`).
   *
   * `404 SERIES_NOT_FOUND` (reusing the exact same code the admin surface
   * already uses for "no such id" — no new error code) for THREE distinct
   * conditions, deliberately collapsed into one outcome, matching this
   * codebase's established anti-enumeration precedent
   * (`VideosService#findPublishedRow`'s doc comment): no such `Series` row
   * at all; a `Series` row that exists but is archived (archived is
   * "excluded from the public list" too, not just hidden from the default
   * admin list — the admin `GET /admin/series/:id` intentionally differs
   * here for operational reasons, this public route does not); and a
   * `Series` row that exists, is active, but currently has zero qualifying
   * episodes (nothing to actually show).
   */
  async findById(id: string): Promise<SeriesDetailPublicDto> {
    const series = await this.prisma.series.findUnique({ where: { id } });

    if (!series || series.archivedAt !== null) {
      throw seriesNotFound();
    }

    const episodes = await this.prisma.video.findMany({
      where: {
        seriesId: id,
        lifecycleState: MediaLifecycleState.PUBLISHED,
        contentKind: VideoContentKind.DRAMA,
      },
      orderBy: { episodeNumber: 'asc' },
    });

    if (episodes.length === 0) {
      throw seriesNotFound();
    }

    const publicDto = await this.toPublicDto(series, episodes);

    return {
      ...publicDto,
      episodes: episodes.map((episode) =>
        toVideoResponseDto(
          toVideoRecord(episode),
          this.appConfig.publicBaseUrl,
        ),
      ),
    };
  }

  /**
   * Batched (one query, not N) lookup of every qualifying episode across
   * `seriesIds`, grouped by `seriesId` — avoids an N+1 query in `list`.
   */
  private async loadQualifyingEpisodesBySeriesId(
    seriesIds: string[],
  ): Promise<Map<string, VideoRow[]>> {
    const rows = await this.prisma.video.findMany({
      where: {
        seriesId: { in: seriesIds },
        lifecycleState: MediaLifecycleState.PUBLISHED,
        contentKind: VideoContentKind.DRAMA,
      },
    });

    const bySeriesId = new Map<string, VideoRow[]>();
    for (const row of rows) {
      const bucket = bySeriesId.get(row.seriesId);
      if (bucket) {
        bucket.push(row);
      } else {
        bySeriesId.set(row.seriesId, [row]);
      }
    }

    return bySeriesId;
  }

  private async toPublicDto(
    series: SeriesRow,
    episodes: VideoRow[],
  ): Promise<SeriesPublicDto> {
    return {
      id: series.id,
      title: series.title,
      coverUrl: await this.resolveCoverUrl(series.coverImageKey),
      ...computeSeriesAggregate(episodes, this.entitlementsService),
    };
  }

  /**
   * Mirrors `VideosService.getPlaybackUrl`'s established R2 pattern
   * (presigned GET, minted fresh per request, never persisted) — applied
   * here to `Series.coverImageKey` instead of a video's playable source.
   * `DEFAULT_GET_URL_EXPIRY_SECONDS` (1 hour, not the video-specific
   * `PLAYBACK_URL_EXPIRY_SECONDS`), because a cover image is a generic,
   * cacheable display asset with no playback-authorization semantics —
   * unlike `playbackUrl`, a longer-lived cover URL does not gate access to
   * anything.
   */
  private async resolveCoverUrl(
    coverImageKey: string | null,
  ): Promise<string | null> {
    if (!coverImageKey) {
      return null;
    }

    const signed = await this.storageService.createPresignedGetUrl(
      coverImageKey,
      { expiresInSeconds: DEFAULT_GET_URL_EXPIRY_SECONDS },
    );

    return signed.url;
  }
}

function seriesNotFound(): AppException {
  return new AppException(
    AppErrorCode.SERIES_NOT_FOUND,
    'Series not found',
    HttpStatus.NOT_FOUND,
  );
}

/**
 * Truthful, request-time-computed aggregates over a series's qualifying
 * episodes. `category`/`sourceLanguage` are the shared value across every
 * episode, or `null` — NEVER a majority vote, a first-episode value, or any
 * other guess — the instant two qualifying episodes disagree (never
 * observed for the 4 real seed series: each is uniform on both fields, see
 * the backfill migration's own verification query, but this function makes
 * no assumption of uniformity). `hasPremiumEpisodes` reuses
 * `EntitlementsService.resolveEpisodePremium` — the exact same
 * override-aware rule `VideosController#enforceEntitlementGate` already
 * enforces at stream/playback time — rather than re-deriving a parallel
 * free/premium rule that could drift from it.
 */
function computeSeriesAggregate(
  episodes: VideoRow[],
  entitlementsService: EntitlementsService,
): Omit<SeriesPublicDto, 'id' | 'title' | 'coverUrl'> {
  const categories = new Set(episodes.map((episode) => episode.category));
  const sourceLanguages = new Set(
    episodes.map((episode) => episode.sourceLanguage),
  );
  const totalLikes = episodes.reduce(
    (sum, episode) => sum + episode.likeCount,
    0,
  );
  const hasPremiumEpisodes = episodes.some((episode) =>
    entitlementsService.resolveEpisodePremium(episode, FREE_EPISODE_LIMIT),
  );

  return {
    category: soleValueOrNull(categories),
    sourceLanguage: soleValueOrNull(sourceLanguages),
    episodeCount: episodes.length,
    totalLikes,
    hasPremiumEpisodes,
  };
}

function soleValueOrNull(values: Set<string>): string | null {
  return values.size === 1 ? [...values][0] : null;
}
