import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { redactSensitiveText } from '../common/logging/redact';
import { RootConfig } from '../config/configuration';
import { deriveAccessTier } from '../entitlements/entitlement.constants';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { TranscodeIntentService } from '../transcode/transcode-intent.service';
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
  // Included so a row misclassified at creation time can be corrected
  // through the guarded admin API rather than by hand-written SQL - which
  // is exactly how the two pre-existing QA fixtures had to be fixed.
  'contentKind',
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
  /** Plain string at rest, like `lifecycleState` - see the schema comment. */
  contentKind: string;
  objectStorageKey: string | null;
  objectStorageVariant: string | null;
  coverImageKey: string | null;
  thumbnailImageKey: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  accessTierOverride: string | null;
  expectedSizeBytes: number | null;
  expectedContentType: string | null;
  /**
   * Slice 11P: read (never written) by `assertHlsReadyForPublish` below —
   * see that method's doc comment. Not surfaced on `AdminMediaDto` by this
   * slice (an admin processing-status UI is 11U's scope, not 11P's).
   */
  processingState: string | null;
  hlsMasterKey: string | null;
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
  private readonly logger = new Logger(AdminMediaService.name);

  /**
   * `configService`/`transcodeIntentService` are Slice 11N additions, both
   * `@Optional()` — deliberately so this service keeps compiling and
   * behaving exactly as before for every test that constructs it directly
   * (e.g. `admin-media.service.spec.ts`'s bare `providers: [AdminMediaService,
   * ...]` array, which imports neither `ConfigModule` nor `TranscodeModule`)
   * without those tests needing to change at all. When either is absent
   * (`undefined`), `completeUpload` below treats transcode processing as
   * disabled — the exact same effective behavior as `TRANSCODE_ENABLED=false`.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly mediaLifecycleService: MediaLifecycleService,
    @Optional() private readonly configService?: ConfigService<RootConfig>,
    @Optional()
    private readonly transcodeIntentService?: TranscodeIntentService,
  ) {}

  async createUpload(
    dto: CreateMediaUploadDto,
  ): Promise<CreateMediaUploadResponseDto> {
    await this.assertNoDuplicateEpisodeNumber(dto.seriesId, dto.episodeNumber);

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
        // Work unit 11L-B2: the server-side upload EXPECTATION — see
        // `Video.expectedSizeBytes`/`expectedContentType`'s schema doc
        // comment (11L-B1) for why this must be recorded here, at initiate
        // time, rather than accepted again at `completeUpload`.
        expectedSizeBytes: dto.sizeBytes,
        expectedContentType: dto.contentType,
        lifecycleState: MediaLifecycleState.DRAFT,
        // Explicit when the caller declared one, otherwise the column
        // default (`drama`). An internal fixture can therefore mark itself
        // at creation time instead of being indistinguishable from real
        // content until someone patches it in SQL.
        ...(dto.contentKind === undefined
          ? {}
          : { contentKind: dto.contentKind }),
        // Work unit 11F-4: every newly created row gets an explicit
        // access tier at creation time, derived from `episodeNumber`
        // exactly like the backfill migration and `prisma/seed.ts` do —
        // no admin-created row is left `null`. Admins can still change it
        // afterward via the existing `PATCH /admin/media/:id/access-tier`
        // endpoint (`updateAccessTier` below), which remains the only way
        // to set an override that intentionally disagrees with
        // `episodeNumber`.
        accessTierOverride: deriveAccessTier(dto.episodeNumber),
      },
    });

    return {
      media: toAdminMediaDto(created),
      upload: toPresignedUploadDto(presigned),
    };
  }

  /**
   * Work unit 11L-B3: hardened completion. Previously this only asked
   * `StorageService.objectExists` a yes/no question and trusted it — that
   * verifies presence, not that the uploaded bytes are actually what was
   * expected. Now it calls `StorageService.headObject` and verifies THREE
   * things, in order, before any lifecycle transition or database write
   * happens: (1) the object exists at all, (2) its real size
   * (`ContentLength`) matches `Video.expectedSizeBytes`, (3) its real
   * `Content-Type` matches `Video.expectedContentType` — both recorded by
   * `createUpload` (11L-B2) from the CLIENT's own declaration at initiate
   * time, so the completing caller cannot restate either value here to make
   * the check pass vacuously (see `Video.expectedSizeBytes`'s schema doc
   * comment for the full rationale). On ANY of the three failures this
   * throws before `assertTransition`/`prisma.video.update` are ever
   * reached — the row's `lifecycleState` stays exactly where it was
   * (`draft`), no partial data is written, and the SAME `completeUpload`
   * call can simply be retried once the real problem is fixed (re-upload,
   * or an initiate with a correct declaration). Every thrown message states
   * only the mismatch itself (expected vs. actual size/type) — never the
   * bucket, endpoint, object key, or a signed URL.
   *
   * Backward compatibility: a row created before this slice has
   * `expectedSizeBytes`/`expectedContentType` both `null` (the additive
   * migration backfills no existing row). For those, and ONLY those, steps
   * (2)/(3) are skipped and this falls back to the pre-11L existence-only
   * check. This can never be used to bypass verification on a NEW row: since
   * `CreateMediaUploadDto.sizeBytes`/`contentType` are now required
   * (11L-B2), every row `createUpload` creates after this slice always has
   * both fields set, so a `null` expectation is structurally impossible for
   * a freshly created row.
   */
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

    const metadata = await this.storageService.headObject(
      media.objectStorageKey,
    );

    if (metadata === null) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'No object was found at the presigned upload key',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (
      media.expectedSizeBytes !== null &&
      metadata.contentLength !== media.expectedSizeBytes
    ) {
      throw new AppException(
        AppErrorCode.UPLOAD_SIZE_MISMATCH,
        `Uploaded object size does not match the expected size ` +
          `(expected ${media.expectedSizeBytes} bytes, got ${metadata.contentLength} bytes)`,
        HttpStatus.CONFLICT,
      );
    }

    if (
      media.expectedContentType !== null &&
      metadata.contentType !== media.expectedContentType
    ) {
      throw new AppException(
        AppErrorCode.UPLOAD_CONTENT_TYPE_MISMATCH,
        `Uploaded object content type does not match the expected ` +
          `content type (expected "${media.expectedContentType}", got ` +
          `"${metadata.contentType ?? 'unknown'}")`,
        HttpStatus.CONFLICT,
      );
    }

    const nextState = this.mediaLifecycleService.assertTransition(
      asLifecycleState(media.lifecycleState),
      MediaLifecycleState.READY,
    );

    const readyUpdateData = {
      lifecycleState: nextState,
      durationSeconds: dto.durationSeconds ?? media.durationSeconds,
      width: dto.width ?? media.width,
      height: dto.height ?? media.height,
    };

    // Slice 11N/11P: `isTranscodeEnabled` is `false` whenever `configService`
    // is absent (every test that does not wire `ConfigModule`/
    // `TranscodeModule`, matching this constructor's `@Optional()` doc
    // comment) or when `TRANSCODE_ENABLED` did not resolve to exactly
    // `true` — in both cases the plain, non-transactional branch below runs
    // and `completeUpload`'s behavior/return value is BYTE-IDENTICAL to
    // before this slice (proof 16 / the 2026-08-10 Slice 11P approval's
    // "flag off ⇒ byte-identical existing behavior" requirement), which is
    // what every pre-existing complete-upload unit/e2e test still asserts,
    // completely unmodified by this slice.
    const isTranscodeEnabled =
      this.configService?.get('transcode', { infer: true })?.enabled === true;

    let updated: VideoRow;
    let processingVersion: number | undefined;

    if (isTranscodeEnabled && this.transcodeIntentService) {
      const transcodeIntentService = this.transcodeIntentService;

      // Slice 11P — RESOLVES the carried 11N/11O REQUIRED concern (control
      // workspace DECISIONS.md, "2026-08-10 — Slice 11P APPROVED..." entry,
      // binding constraint 5): the durable DB intent
      // (`TranscodeIntentService.recordIntent` — processingVersion
      // increment + processingState="queued" + attempts/step/error fields
      // reset) is created INSIDE the SAME `prisma.$transaction` as this
      // upload-completion ready-transition. Either BOTH writes commit
      // together, or NEITHER does — a durable-intent failure can never
      // leave the row silently `ready` with no processing ever requested
      // (a "ready but never queued" state, which the approval explicitly
      // forbids), and it can never leave a "half-completed" row either.
      //
      // Idempotency is preserved exactly as before: `assertTransition`
      // above already guarantees this whole block only runs on a genuine
      // `draft -> ready` transition — a REPEATED `completeUpload` call
      // against an already-`ready` (or later) row throws
      // `INVALID_MEDIA_LIFECYCLE_TRANSITION` before this transaction is ever
      // opened, so a retried completion call can never double-increment
      // `processingVersion` or enqueue a second generation for the same
      // upload.
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const readyRow = await tx.video.update({
            where: { id },
            data: readyUpdateData,
          });
          const version = await transcodeIntentService.recordIntent(tx, id);
          return { readyRow, version };
        });

        updated = result.readyRow;
        processingVersion = result.version;
      } catch (error) {
        // Loud and explicit, per the approval: the transaction rolled back
        // (or never committed), so `lifecycleState` is STILL `draft` — this
        // is never treated as "scheduled". The client may safely retry this
        // same `complete-upload` call once the underlying issue (e.g. a
        // transient database failure) is resolved.
        this.logger.error(
          redactSensitiveText(
            `Failed to record HLS processing intent for media "${id}" ` +
              `during upload completion — the completion was NOT applied ` +
              `(the transaction rolled back): ${String(error)}`,
          ),
        );

        throw new AppException(
          AppErrorCode.MEDIA_PROCESSING_INTENT_FAILED,
          'Failed to record HLS processing intent for this upload ' +
            'completion — the upload was not marked ready. Retry ' +
            'completion once the underlying issue is resolved.',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    } else {
      updated = await this.prisma.video.update({
        where: { id },
        data: readyUpdateData,
      });
    }

    // Enqueue stays POST-COMMIT and best-effort (proposal §8 / 2026-08-10
    // approval: "Enqueue stays post-commit best-effort"): the durable intent
    // above has already committed by this point, so a Redis/enqueue failure
    // here can never lose the intent — `TranscodeReconcilerService.reconcile`
    // recovers a "queued but never enqueued" row on its next sweep (11N,
    // extended for 11P — see that service's own doc comment). This mirrors
    // the proposal's "Redis temporarily down ... upload flow never breaks"
    // failure behavior (§14): a failure to even enqueue must never surface as
    // a failure of the upload-completion call the admin is waiting on.
    if (
      isTranscodeEnabled &&
      this.transcodeIntentService &&
      processingVersion !== undefined
    ) {
      await this.transcodeIntentService.enqueueBestEffort(
        id,
        processingVersion,
      );
    }

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
   *
   * Work unit 11F-3: when the body includes `episodeNumber` and it differs
   * from the row's current value, this also rejects with a 409
   * `DUPLICATE_EPISODE_NUMBER` if ANOTHER row (`id !=` this one) in the same
   * series already has that episode number. `seriesId` itself is not
   * editable here (see the whitelist above), so the row's existing
   * `seriesId` is always the one checked against.
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

    const media = await this.findMediaOrThrow(id);

    if (
      data.episodeNumber !== undefined &&
      data.episodeNumber !== media.episodeNumber
    ) {
      await this.assertNoDuplicateEpisodeNumber(
        media.seriesId,
        data.episodeNumber,
        id,
      );
    }

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
   *
   * Work unit 11F-2: three additional optional filters — `search`
   * (case-insensitive substring across `title`/`caption`/`channelName`),
   * `tier` (exact match on `accessTierOverride`), and `category` (exact
   * match) — all ANDed together with `status`/`seriesId` and with each
   * other (Prisma's default `where` object semantics: every top-level key
   * is an implicit AND; `search`'s three-field `OR` nests inside that AND
   * as its own key). None of these re-derive anything from `episodeNumber`
   * — `tier` reads the DB column directly, matching 11F-4.
   */
  async list(
    query: ListAdminMediaQueryDto,
  ): Promise<AdminMediaListResponseDto> {
    const page = query.page;
    const pageSize = query.pageSize;
    const search = query.search?.trim();
    const where = {
      ...(query.status ? { lifecycleState: query.status } : {}),
      ...(query.seriesId ? { seriesId: query.seriesId } : {}),
      ...(query.tier ? { accessTierOverride: query.tier } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { caption: { contains: search, mode: 'insensitive' as const } },
              {
                channelName: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
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

    if (to === MediaLifecycleState.PUBLISHED) {
      this.assertHlsReadyForPublish(media);
    }

    const updated = await this.prisma.video.update({
      where: { id },
      data: { lifecycleState: nextState },
    });

    return toAdminMediaDto(updated);
  }

  /**
   * Slice 11P — publish gate (2026-08-10 approval, binding constraint 10):
   * an ADDITIVE guard on top of `MediaLifecycleService`'s existing editorial
   * transition rules, checked ONLY for rows where `processingState IS NOT
   * NULL` (an HLS-pipeline row). Such a row may only publish once
   * `processingState === "ready"` AND `hlsMasterKey` is non-null — i.e. a
   * fully verified, promoted HLS generation actually exists.
   *
   * Rows with `processingState === null` (every legacy/local row, and the
   * pre-HLS published R2 fixture row) are COMPLETELY unaffected: this method
   * returns immediately for them, so their publish/unpublish behavior stays
   * byte-identical to before this slice — the old catalog is never suddenly
   * required to have HLS output.
   */
  private assertHlsReadyForPublish(media: VideoRow): void {
    if (media.processingState === null) {
      return;
    }

    if (media.processingState !== 'ready' || !media.hlsMasterKey) {
      throw new AppException(
        AppErrorCode.HLS_NOT_READY_FOR_PUBLISH,
        `Media "${media.id}" cannot be published until HLS processing is ` +
          `ready (processingState=${JSON.stringify(media.processingState)})`,
        HttpStatus.CONFLICT,
      );
    }
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

  /**
   * Work unit 11F-3: a clean, application-level duplicate check — no DB
   * unique constraint/migration is added for this (see the class doc on
   * `AdminMediaService` and DECISIONS.md for why this slice stays
   * validation-only). Used by both `createUpload` (no `excludeId`, since the
   * row does not exist yet) and `updateMetadata` (`excludeId` set to the
   * row being edited, so a PATCH that changes some other field while
   * leaving `episodeNumber` pointed at the row's own current value never
   * collides with itself).
   */
  private async assertNoDuplicateEpisodeNumber(
    seriesId: string,
    episodeNumber: number,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.video.findFirst({
      where: {
        seriesId,
        episodeNumber,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new AppException(
        AppErrorCode.DUPLICATE_EPISODE_NUMBER,
        `Episode number ${episodeNumber} already exists in series "${seriesId}"`,
        HttpStatus.CONFLICT,
      );
    }
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
