import { open } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppConfig,
  ContentAccessMode,
  DEFAULT_CONTENT_ACCESS_MODE,
  RootConfig,
  StorageConfig,
} from '../config/configuration';
import { readContentAccessMode } from '../config/content-access-mode.util';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { FREE_EPISODE_LIMIT } from '../entitlements/entitlement.constants';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MediaLifecycleState } from '../media/media-lifecycle.types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { VideoContentKind } from '../videos/video-content-kind.types';
import {
  toVideoRecord,
  toVideoResponseDto,
} from '../videos/video-response.util';
import {
  COVER_MAGIC_BYTE_LENGTH,
  resolveLocalCoverPath,
  sniffSeriesCoverContentType,
} from './local-series-cover.util';
import { isValidSeriesCoverObjectKey } from './series-cover-key.util';
import {
  resolveSeriesCoverUrl,
  SeriesCoverUrlContext,
} from './series-cover-url.util';
import { LocalSeriesCoverFile } from './series-public.types';
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
  /**
   * Work unit "V1 FREE ACCESS POLICY": read once at construction through the
   * shared `readContentAccessMode` helper, and fed to BOTH tier-dependent
   * answers this service produces — the embedded episodes'
   * `VideoResponseDto.accessTier` and the `hasPremiumEpisodes` aggregate —
   * so a series can never advertise premium episodes that the gate is in
   * fact serving to everyone.
   */
  private readonly contentAccessMode: ContentAccessMode;
  /**
   * Work unit "LOCAL SERIES COVER ARTWORK": the active storage driver and the
   * origin this API is reachable on, read ONCE at construction (this service
   * is a singleton) and handed to `resolveSeriesCoverUrl` for every row —
   * never re-read per series, and never read from `process.env` below.
   */
  private readonly coverUrlContext: SeriesCoverUrlContext;
  private readonly storageConfig: StorageConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly entitlementsService: EntitlementsService,
    private readonly configService: ConfigService<RootConfig>,
  ) {
    this.appConfig = this.configService.get('app', { infer: true })!;
    this.contentAccessMode = readContentAccessMode(this.configService);
    this.storageConfig = this.configService.get('storage', { infer: true })!;
    this.coverUrlContext = {
      driver: this.storageConfig.driver,
      publicBaseUrl: this.appConfig.publicBaseUrl,
    };
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
          this.contentAccessMode,
        ),
      ),
    };
  }

  /**
   * Work unit "LOCAL SERIES COVER ARTWORK": everything
   * `SeriesPublicController#getCover` needs to stream one series's artwork
   * off the local object store, or `null` when there is nothing truthful to
   * serve. `null` — never a placeholder, a redirect, or a generated image —
   * is what lets the app fall back to the branded initial tile it already
   * shows for a series with no cover.
   *
   * Every one of the five ways this returns `null` is deliberate:
   *
   *  1. `driver !== 'local'`. This route is the LOCAL driver's cover surface
   *     and nothing else. Under `r2` the authoritative `coverUrl` is a
   *     presigned bucket URL and no client is pointed here, so serving local
   *     files would at best shadow the real answer and at worst expose bytes
   *     a production deployment never meant this process to hand out. The
   *     check is explicit rather than implied by an empty directory.
   *  2. No such series, or an archived one. `list`/`findById` already hide
   *     archived series; their artwork must not remain independently
   *     fetchable afterwards.
   *  3. No `coverImageKey`. The row is authoritatively without artwork.
   *  4. A `coverImageKey` this series' own upload flow could not have minted
   *     (`isValidSeriesCoverObjectKey`). Only the exact
   *     `admin-series/<id>/cover/<uuid>` shape is servable, which is what
   *     makes a traversal structurally impossible here rather than merely
   *     guarded against — and it also means a key belonging to a DIFFERENT
   *     series can never be served under this series' id.
   *  5. The file is missing, unreadable, or its leading bytes are not one of
   *     `ALLOWED_SERIES_COVER_CONTENT_TYPES`. A cover that is not provably a
   *     JPEG/PNG/WebP is not served at all.
   *
   * The caller cannot distinguish these, by design: all five answer 404.
   */
  async resolveLocalCoverFile(
    id: string,
  ): Promise<LocalSeriesCoverFile | null> {
    if (this.storageConfig.driver !== 'local') {
      return null;
    }

    const series = await this.prisma.series.findFirst({
      where: { id, archivedAt: null },
      select: { id: true, coverImageKey: true },
    });

    if (
      !series?.coverImageKey ||
      !isValidSeriesCoverObjectKey(series.id, series.coverImageKey)
    ) {
      return null;
    }

    const absolutePath = resolveLocalCoverPath(
      this.storageConfig.localRoot,
      series.coverImageKey,
    );

    if (absolutePath === null) {
      return null;
    }

    return readLocalCoverFile(absolutePath);
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
      coverUrl: await resolveSeriesCoverUrl(
        this.storageService,
        this.coverUrlContext,
        series,
      ),
      ...computeSeriesAggregate(
        episodes,
        this.entitlementsService,
        this.contentAccessMode,
      ),
    };
  }
}

/**
 * Opens `absolutePath`, confirms it is a regular file whose leading bytes are
 * a permitted cover format, and returns the handle-free facts the controller
 * needs to stream it.
 *
 * The size comes from `fstat` on the SAME open descriptor the magic bytes were
 * read from, not from a separate `stat` on the path — so the `Content-Length`
 * this route advertises always describes the exact file whose type was
 * verified, even if the path is replaced between the two operations.
 *
 * Any filesystem error resolves to `null` rather than propagating: a missing
 * or unreadable cover is a 404, not a 500, and the caller must not be able to
 * tell those apart. The descriptor is closed on every path.
 */
async function readLocalCoverFile(
  absolutePath: string,
): Promise<LocalSeriesCoverFile | null> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(absolutePath, 'r');

    const stats = await handle.stat();

    if (!stats.isFile()) {
      return null;
    }

    const header = Buffer.alloc(COVER_MAGIC_BYTE_LENGTH);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const contentType = sniffSeriesCoverContentType(
      header.subarray(0, bytesRead),
    );

    if (contentType === null) {
      return null;
    }

    return { absolutePath, contentType, fileSize: stats.size };
  } catch {
    return null;
  } finally {
    await handle?.close();
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
 *
 * Work unit "V1 FREE ACCESS POLICY": `accessMode` is threaded into that
 * same call for the same reason — under `CONTENT_ACCESS_MODE=free` the gate
 * serves every published episode, so `hasPremiumEpisodes` must report
 * `false` or the series list would advertise a lock the backend does not
 * apply (and that V1 offers no way to unlock). Defaults to `entitlement`,
 * i.e. today's behavior, for a caller that omits it.
 */
function computeSeriesAggregate(
  episodes: VideoRow[],
  entitlementsService: EntitlementsService,
  accessMode: ContentAccessMode = DEFAULT_CONTENT_ACCESS_MODE,
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
    entitlementsService.resolveEpisodePremium(
      episode,
      FREE_EPISODE_LIMIT,
      accessMode,
    ),
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
