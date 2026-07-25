import { randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CompleteMediaUploadDto } from './dto/complete-media-upload.dto';
import { CreateMediaAssetUploadDto } from './dto/create-media-asset-upload.dto';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto';
import { ListAdminMediaQueryDto } from './dto/list-admin-media-query.dto';
import { UpdateAccessTierDto } from './dto/update-access-tier.dto';
import { UpdateMediaMetadataDto } from './dto/update-media-metadata.dto';
import { MediaLifecycleService } from './media-lifecycle.service';
import {
  buildCoverObjectKey,
  buildSourceObjectKey,
  buildThumbnailObjectKey,
} from './media-storage-key.util';
import { MediaLifecycleState } from './media-lifecycle.types';
import {
  AdminMediaDto,
  AdminMediaListResponseDto,
  CreateMediaUploadResponseDto,
  MediaAssetUploadResponseDto,
} from './media.types';

const MEDIA_ID_PREFIX = 'media';
/** Free-form label for the one rendition this slice ever creates. */
const SOURCE_VARIANT = 'source';

/**
 * Work unit 11E-2: the exhaustive whitelist of `Video` columns
 * `PATCH /admin/media/:id` may write. Deliberately does NOT include
 * `lifecycleState`, any object-storage key, `storageKey`, `sortOrder`,
 * `likeCount`, `durationSeconds`/`width`/`height`, or `accessTierOverride`
 * (11E-3) — see `UpdateMediaMetadataDto`'s class doc for why each of those
 * is out of scope here. Used by `buildMetadataUpdateData` below as a second,
 * defense-in-depth whitelist on top of the global `ValidationPipe`'s
 * `forbidNonWhitelisted`.
 */
const UPDATABLE_METADATA_FIELDS = [
  'title',
  'caption',
  'category',
  'channelName',
  'sourceLanguage',
  'episodeNumber',
  'hasEmbeddedIndonesianSubtitle',
] as const;

/**
 * Work unit 11E-3: the three values `Video.accessTierOverride` may hold.
 * `null` clears the override. `UpdateAccessTierDto`'s `@IsIn` already
 * rejects anything outside this set before `updateAccessTier` below is
 * ever called, so casting the validated `dto.tier` to this type here is
 * safe.
 */
type AccessTierOverride = 'free' | 'premium' | null;

type UpdatableMetadataField = (typeof UPDATABLE_METADATA_FIELDS)[number];
type MetadataUpdateData = Partial<Pick<VideoRow, UpdatableMetadataField>>;

type VideoRow = {
  id: string;
  seriesId: string;
  title: string;
  episodeNumber: number;
  channelName: string;
  caption: string;
  category: string;
  sourceLanguage: string;
  hasEmbeddedIndonesianSubtitle: boolean;
  lifecycleState: string;
  objectStorageKey: string | null;
  objectStorageVariant: string | null;
  coverImageKey: string | null;
  thumbnailImageKey: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  accessTierOverride: string | null;
};

/**
 * Phase 11, work unit 11B-3: the admin media upload/publish pipeline —
 * create-upload (draft + presigned PUT), complete-upload (draft -> ready),
 * publish/unpublish (via `MediaLifecycleService`, 11B-1), and cover/
 * thumbnail asset uploads. `StorageService` is mocked in every test that
 * exercises this service (see `admin-media.service.spec.ts` and
 * `test/admin-media.e2e-spec.ts`) — no real R2/S3 call is ever made.
 *
 * Deliberately does NOT touch `storageKey` (the existing local
 * `STORAGE_ROOT`-relative field `VideosController#streamVideo` resolves
 * against) — admin-created rows are invisible to that route anyway, since
 * `VideosService` only serves `lifecycleState: "published"` rows (see the
 * 11B-3 comment there), and even a `published` admin-created row has no
 * local file at `STORAGE_ROOT` to stream. Wiring playback to object
 * storage is 11A-3, explicitly out of scope for this slice.
 */
@Injectable()
export class AdminMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly mediaLifecycleService: MediaLifecycleService,
  ) {}

  async createUpload(
    dto: CreateMediaUploadDto,
  ): Promise<CreateMediaUploadResponseDto> {
    const id = `${MEDIA_ID_PREFIX}-${randomUUID()}`;
    const objectStorageKey = buildSourceObjectKey(id);

    const presigned = await this.storageService.createPresignedPutUrl(
      objectStorageKey,
      { contentType: dto.contentType },
    );

    const created = await this.prisma.video.create({
      data: {
        id,
        seriesId: dto.seriesId,
        title: dto.title,
        episodeNumber: dto.episodeNumber,
        channelName: dto.channelName,
        caption: dto.caption,
        category: dto.category,
        // Empty, not null: `storageKey` is a required, non-nullable column
        // (it predates this work unit — see `video.types.ts`). An
        // admin-created row is never reachable via the public API until it
        // is `published`, and even then has no local file to stream (see
        // the class doc above), so an empty placeholder here is safe and
        // does not risk `resolveSafeStoragePath` resolving anything real.
        storageKey: '',
        sourceLanguage: dto.sourceLanguage,
        hasEmbeddedIndonesianSubtitle: dto.hasEmbeddedIndonesianSubtitle,
        likeCount: 0,
        durationSeconds: dto.durationSeconds,
        width: dto.width,
        height: dto.height,
        objectStorageKey,
        objectStorageVariant: SOURCE_VARIANT,
        lifecycleState: MediaLifecycleState.DRAFT,
      },
    });

    return {
      media: toAdminMediaDto(created),
      upload: toPresignedUploadDto(presigned),
    };
  }

  async completeUpload(
    id: string,
    dto: CompleteMediaUploadDto,
  ): Promise<AdminMediaDto> {
    const media = await this.findMediaOrThrow(id);

    if (!media.objectStorageKey) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'No upload has been started for this media record',
        HttpStatus.BAD_REQUEST,
      );
    }

    const uploaded = await this.storageService.objectExists(
      media.objectStorageKey,
    );

    if (!uploaded) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'No object was found at the presigned upload key',
        HttpStatus.BAD_REQUEST,
      );
    }

    const nextState = this.mediaLifecycleService.assertTransition(
      asLifecycleState(media.lifecycleState),
      MediaLifecycleState.READY,
    );

    const updated = await this.prisma.video.update({
      where: { id },
      data: {
        lifecycleState: nextState,
        durationSeconds: dto.durationSeconds ?? media.durationSeconds,
        width: dto.width ?? media.width,
        height: dto.height ?? media.height,
      },
    });

    return toAdminMediaDto(updated);
  }

  async publish(id: string): Promise<AdminMediaDto> {
    return this.transitionTo(id, MediaLifecycleState.PUBLISHED);
  }

  async unpublish(id: string): Promise<AdminMediaDto> {
    return this.transitionTo(id, MediaLifecycleState.UNPUBLISHED);
  }

  async createCoverUpload(
    id: string,
    dto: CreateMediaAssetUploadDto,
  ): Promise<MediaAssetUploadResponseDto> {
    return this.createAssetUpload(id, buildCoverObjectKey(id), dto, {
      coverImageKey: buildCoverObjectKey(id),
    });
  }

  async createThumbnailUpload(
    id: string,
    dto: CreateMediaAssetUploadDto,
  ): Promise<MediaAssetUploadResponseDto> {
    return this.createAssetUpload(id, buildThumbnailObjectKey(id), dto, {
      thumbnailImageKey: buildThumbnailObjectKey(id),
    });
  }

  async findById(id: string): Promise<AdminMediaDto> {
    return toAdminMediaDto(await this.findMediaOrThrow(id));
  }

  /**
   * Work unit 11E-2: a partial metadata edit. Validates the "at least one
   * field" rule before touching the database (a pure request-validation
   * concern — `UpdateMediaMetadataDto` cannot express it declaratively),
   * then 404s via `findMediaOrThrow` for an unknown id, then writes only
   * the whitelisted fields present in the body. Every other `Video` column
   * (lifecycle state, object-storage keys, `storageKey`, `sortOrder`,
   * `likeCount`, dimensions/duration, `accessTierOverride`) is left
   * completely untouched by this call.
   */
  async updateMetadata(
    id: string,
    dto: UpdateMediaMetadataDto,
  ): Promise<AdminMediaDto> {
    const data = buildMetadataUpdateData(dto);

    if (Object.keys(data).length === 0) {
      throw new AppException(
        AppErrorCode.EMPTY_MEDIA_METADATA_UPDATE,
        'At least one field must be provided',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.findMediaOrThrow(id);

    const updated = await this.prisma.video.update({
      where: { id },
      data,
    });

    return toAdminMediaDto(updated);
  }

  /**
   * Work unit 11E-3: sets or clears the per-episode `accessTierOverride`.
   * `dto.tier` has already been validated by `UpdateAccessTierDto`'s
   * `@IsIn(['free', 'premium', null])` to be exactly one of those three
   * values before this method is ever called. 404s via `findMediaOrThrow`
   * for an unknown id, matching `updateMetadata`'s precedent. Writes ONLY
   * `accessTierOverride` — every other `Video` column (lifecycle state,
   * object-storage keys, metadata fields, `sortOrder`, `likeCount`,
   * dimensions/duration) is left completely untouched by this call.
   */
  async updateAccessTier(
    id: string,
    dto: UpdateAccessTierDto,
  ): Promise<AdminMediaDto> {
    await this.findMediaOrThrow(id);

    const updated = await this.prisma.video.update({
      where: { id },
      data: { accessTierOverride: dto.tier },
    });

    return toAdminMediaDto(updated);
  }

  /**
   * Work unit 11E-1: the admin inventory list, across ALL five lifecycle
   * states (unlike `VideosService`, which only ever returns `published`
   * rows to the public feed — see the class doc above). Ordered
   * deterministically by `sortOrder` then `id`, matching the existing
   * public-feed ordering convention (`VideosService.findAll`).
   */
  async list(
    query: ListAdminMediaQueryDto,
  ): Promise<AdminMediaListResponseDto> {
    const page = query.page;
    const pageSize = query.pageSize;
    const where = {
      ...(query.status ? { lifecycleState: query.status } : {}),
      ...(query.seriesId ? { seriesId: query.seriesId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.video.count({ where }),
    ]);

    return {
      items: rows.map(toAdminMediaDto),
      total,
      page,
      pageSize,
    };
  }

  private async transitionTo(
    id: string,
    to: MediaLifecycleState,
  ): Promise<AdminMediaDto> {
    const media = await this.findMediaOrThrow(id);
    const nextState = this.mediaLifecycleService.assertTransition(
      asLifecycleState(media.lifecycleState),
      to,
    );

    const updated = await this.prisma.video.update({
      where: { id },
      data: { lifecycleState: nextState },
    });

    return toAdminMediaDto(updated);
  }

  private async createAssetUpload(
    id: string,
    objectKey: string,
    dto: CreateMediaAssetUploadDto,
    persistedKey: Record<string, string>,
  ): Promise<MediaAssetUploadResponseDto> {
    await this.findMediaOrThrow(id);

    const presigned = await this.storageService.createPresignedPutUrl(
      objectKey,
      { contentType: dto.contentType },
    );

    const updated = await this.prisma.video.update({
      where: { id },
      data: persistedKey,
    });

    return {
      media: toAdminMediaDto(updated),
      upload: toPresignedUploadDto(presigned),
    };
  }

  private async findMediaOrThrow(id: string): Promise<VideoRow> {
    const media = await this.prisma.video.findUnique({ where: { id } });

    if (!media) {
      throw new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Media not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return media;
  }
}

function asLifecycleState(value: string): MediaLifecycleState {
  return value as MediaLifecycleState;
}

/**
 * Work unit 11E-2: narrows an `UpdateMediaMetadataDto` down to a Prisma
 * `data` object containing only the fields the caller actually provided
 * (`undefined` entries are skipped, not written as explicit nulls) —
 * iterating `UPDATABLE_METADATA_FIELDS` rather than `Object.keys(dto)` means
 * this can never write a field outside that whitelist, even if a future
 * change to `UpdateMediaMetadataDto` accidentally added one without updating
 * the constant.
 */
function buildMetadataUpdateData(
  dto: UpdateMediaMetadataDto,
): MetadataUpdateData {
  const data: MetadataUpdateData = {};

  for (const field of UPDATABLE_METADATA_FIELDS) {
    const value = dto[field];
    if (value !== undefined) {
      (data as Record<UpdatableMetadataField, unknown>)[field] = value;
    }
  }

  return data;
}

function toAdminMediaDto(record: VideoRow): AdminMediaDto {
  return {
    id: record.id,
    seriesId: record.seriesId,
    title: record.title,
    episodeNumber: record.episodeNumber,
    channelName: record.channelName,
    caption: record.caption,
    category: record.category,
    sourceLanguage: record.sourceLanguage,
    hasEmbeddedIndonesianSubtitle: record.hasEmbeddedIndonesianSubtitle,
    lifecycleState: record.lifecycleState,
    objectStorageKey: record.objectStorageKey,
    objectStorageVariant: record.objectStorageVariant,
    coverImageKey: record.coverImageKey,
    thumbnailImageKey: record.thumbnailImageKey,
    durationSeconds: record.durationSeconds,
    width: record.width,
    height: record.height,
    accessTierOverride: asAccessTierOverride(record.accessTierOverride),
  };
}

/**
 * Narrows the DB column's plain `string | null` type to the DTO's
 * `'free' | 'premium' | null` union. Safe because `updateAccessTier` is the
 * only write path for this column (besides the additive migration, which
 * only ever produces `null`) and it is gated by `UpdateAccessTierDto`'s
 * `@IsIn(['free', 'premium', null])`.
 */
function asAccessTierOverride(value: string | null): AccessTierOverride {
  return value as AccessTierOverride;
}

function toPresignedUploadDto(presigned: {
  url: string;
  key: string;
  expiresAt: Date;
}): { url: string; key: string; expiresAt: string } {
  return {
    url: presigned.url,
    key: presigned.key,
    expiresAt: presigned.expiresAt.toISOString(),
  };
}
