import { Logger } from '@nestjs/common';
import type { ContentAccessMode } from '../config/configuration';
import { DEFAULT_CONTENT_ACCESS_MODE } from '../config/configuration';
import {
  FREE_EPISODE_LIMIT,
  resolveAccessTier,
} from '../entitlements/entitlement.constants';
import { VideoContentKind } from './video-content-kind.types';
import { VideoRecord, VideoResponseDto } from './video.types';

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": extracted,
 * behavior-preserving, from what used to be three private
 * members/functions of `VideosService` (`toVideoRecord`, `toResponseDto`,
 * and the module-level `toVideoContentKind`). No logic changed — every
 * existing caller (`VideosService#findAll`/`#findById`/etc., still
 * delegating to these exact same functions) produces byte-identical output
 * to before this extraction.
 *
 * WHY EXTRACTED: the new public `GET /series/:id` (`PublicSeriesService`,
 * `../series/series-public.service.ts`) embeds full episode objects that
 * must be byte-identical to `GET /videos/feed`'s `VideoResponseDto` shape —
 * same `playbackUrl` construction, same `contentKind` narrowing rule
 * (fail-open, warn-logged). Duplicating that logic in the series module
 * would let the two responses silently drift the next time either one
 * changes; a single shared, pure, exported set of functions makes that
 * impossible by construction. Nothing here reads a DB row itself — callers
 * (`VideosService`, `PublicSeriesService`) supply the raw Prisma row they
 * already fetched, so this stays free of any Prisma/network dependency and
 * is trivially unit-testable in isolation.
 */

const contentKindLogger = new Logger('VideoContentKind');

/**
 * Narrows the persisted `Video.contentKind` string to the enum.
 *
 * Deliberately fail-OPEN: an unknown value becomes `DRAMA`. The alternative
 * (defaulting to `QA_FIXTURE`) would let a typo or a future third kind
 * silently erase real content from every consumer catalog, which is a far
 * worse failure than a fixture briefly showing up.
 */
export function toVideoContentKind(value: string): VideoContentKind {
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
  // elsewhere: the column is a plain string at rest, so comparing it to an
  // enum member is exactly the widening this codebase already does at that
  // boundary.
  return value === (VideoContentKind.QA_FIXTURE as string)
    ? VideoContentKind.QA_FIXTURE
    : VideoContentKind.DRAMA;
}

/**
 * Prisma's generated `Video` type represents nullable optional columns as
 * `T | null`, whereas `VideoRecord` (used across the rest of the app,
 * including `videos.data.ts`) represents them as `T | undefined`. This
 * normalizes the DB row into the app-level shape without changing any
 * value that was actually present.
 */
export function toVideoRecord(record: {
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

/**
 * Builds the public `VideoResponseDto` shape from an app-level
 * `VideoRecord` — identical field-for-field to `GET /videos/feed`'s items
 * (`VideosService#toResponseDto` before this extraction). `publicBaseUrl`
 * is passed explicitly rather than read from `ConfigService` here, so this
 * stays a pure function usable outside `VideosService`'s DI context.
 *
 * Work unit "V1 FREE ACCESS POLICY": `accessMode` is passed explicitly for
 * the SAME reason `publicBaseUrl` is — this module must stay pure and
 * DI-free, so it never reaches for `ConfigService` or `process.env` itself.
 * Its two production callers (`VideosService#toResponseDto` and
 * `PublicSeriesService`) each resolve the mode once, in their own
 * constructor, via `readContentAccessMode`. Defaults to `entitlement`
 * (today's behavior) so an omission keeps enforcing the paywall rather than
 * publishing premium content — see `resolveAccessTier`'s doc comment.
 */
export function toVideoResponseDto(
  record: VideoRecord,
  publicBaseUrl: string,
  accessMode: ContentAccessMode = DEFAULT_CONTENT_ACCESS_MODE,
): VideoResponseDto {
  return {
    id: record.id,
    seriesId: record.seriesId,
    title: record.title,
    episodeNumber: record.episodeNumber,
    channelName: record.channelName,
    caption: record.caption,
    category: record.category,
    storageKey: record.storageKey,
    playbackUrl: `${publicBaseUrl}/videos/${record.id}/stream`,
    sourceLanguage: record.sourceLanguage,
    hasEmbeddedIndonesianSubtitle: record.hasEmbeddedIndonesianSubtitle,
    likeCount: record.likeCount,
    durationSeconds: record.durationSeconds,
    width: record.width,
    height: record.height,
    contentKind: record.contentKind,
    // Work unit "Episode Access-Tier + Category Contract Hardening": the
    // SAME resolver the stream/playback authorization gate and the series
    // `hasPremiumEpisodes` aggregate use — see `VideoResponseDto.accessTier`'s
    // doc comment. `record.accessTierOverride` defaults to `null` (not
    // `undefined`) here only for the seed-source array
    // (`videos.data.ts`), which never sets this optional field; every real
    // `Video` row always supplies it explicitly via `toVideoRecord`.
    accessTier: resolveAccessTier(
      {
        accessTierOverride: record.accessTierOverride ?? null,
        episodeNumber: record.episodeNumber,
      },
      FREE_EPISODE_LIMIT,
      accessMode,
    ),
  };
}
