import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { MediaLifecycleState } from '../media/media-lifecycle.types';
import { RootConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CompleteSeriesCoverUploadDto } from './dto/complete-series-cover-upload.dto';
import { CreateSeriesCoverUploadDto } from './dto/create-series-cover-upload.dto';
import { CreateSeriesDto } from './dto/create-series.dto';
import { ListAdminSeriesQueryDto } from './dto/list-admin-series-query.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import {
  buildSeriesCoverObjectKey,
  isValidSeriesCoverObjectKey,
} from './series-cover-key.util';
import {
  ALLOWED_SERIES_COVER_CONTENT_TYPES,
  AllowedSeriesCoverContentType,
  MAX_SERIES_COVER_UPLOAD_BYTES,
} from './series-cover.constants';
import {
  resolveSeriesCoverUrl,
  SeriesCoverUrlContext,
} from './series-cover-url.util';
import {
  CreateSeriesCoverUploadResponseDto,
  SeriesDto,
  SeriesWithCoverDto,
} from './series.types';

/**
 * Work unit 11E-4: the exhaustive whitelist of `Series` columns
 * `PATCH /admin/series/:id` may write. Deliberately does NOT include `id`
 * (immutable, see `UpdateSeriesDto`'s class doc) or `createdAt`/`updatedAt`
 * (server-managed). Used by `buildUpdateData` below as a second,
 * defense-in-depth whitelist on top of the global `ValidationPipe`'s
 * `forbidNonWhitelisted`, mirroring `AdminMediaService`'s
 * `UPDATABLE_METADATA_FIELDS` precedent.
 */
const UPDATABLE_SERIES_FIELDS = [
  'title',
  'coverImageKey',
  'sortOrder',
] as const;

type UpdatableSeriesField = (typeof UPDATABLE_SERIES_FIELDS)[number];
type SeriesUpdateData = Partial<Pick<SeriesRow, UpdatableSeriesField>>;

type SeriesRow = {
  id: string;
  title: string;
  coverImageKey: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /**
   * Fix cycle 1 (2026-08-15): the durable upload-intent column — see its
   * schema doc comment in `prisma/schema.prisma`. Internal bookkeeping only;
   * never included in `SeriesDto`/`SeriesWithCoverDto` (see `toSeriesDto`).
   */
  pendingCoverImageKey: string | null;
};

/**
 * Fix cycle 1: the actual Prisma `data` shape `update` may write — a strict
 * superset of the client-whitelisted `SeriesUpdateData` (`UPDATABLE_SERIES_
 * FIELDS`) that additionally allows the server-internal `pendingCoverImageKey`
 * column. Kept as its own type (rather than widening `SeriesUpdateData`
 * itself) so `buildUpdateData`'s whitelist — the defense-in-depth guarantee
 * that a caller-supplied `UpdateSeriesDto` can only ever populate the three
 * client-editable fields — stays completely unchanged; `pendingCoverImageKey`
 * is added separately, in `update` itself, only for the one specific case
 * (`dto.coverImageKey === null`) that must also clear it.
 */
type SeriesWriteData = SeriesUpdateData & {
  pendingCoverImageKey?: string | null;
};

/** Postgres unique-violation error code, per Prisma's documented mapping. */
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Phase 11, work unit 11E-4 (extended in 11F-1 with read-detail, safe
 * archive/unarchive, and a guarded hard delete): a `Series` row purely
 * ANNOTATES an existing/planned `Video.seriesId` grouping (display title,
 * cover image, manual ordering, archive state); it never reads or writes
 * any `Video` row EXCEPT for the read-only published-episode COUNT
 * `remove` performs to decide whether a hard delete is safe (see `remove`'s
 * doc). No route in this service is reachable from the public API — every
 * method here is called only from `SeriesController`, guarded by
 * `JwtAuthGuard`+`AdminGuard`. The public `/videos/feed` grouping (still
 * computed client-side from `Video.seriesId`) is completely unaffected by
 * anything in this file.
 */
@Injectable()
export class SeriesService {
  /**
   * Work unit "LOCAL SERIES COVER ARTWORK": the admin read surface resolves
   * `coverUrl` through the SAME driver-aware `resolveSeriesCoverUrl` the
   * public catalog uses (acceptance criterion 5 of the cover-upload contract
   * — one mechanism, not two), so it needs the same deployment context. Read
   * once at construction; this service is a singleton.
   *
   * Without this, the admin dashboard under `STORAGE_DRIVER=local` would
   * receive presigned URLs signed against empty R2 credentials: not an error,
   * just artwork that never loads.
   */
  private readonly coverUrlContext: SeriesCoverUrlContext;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    configService: ConfigService<RootConfig>,
  ) {
    const appConfig = configService.get('app', { infer: true })!;
    const storageConfig = configService.get('storage', { infer: true })!;

    this.coverUrlContext = {
      driver: storageConfig.driver,
      publicBaseUrl: appConfig.publicBaseUrl,
    };
  }

  /**
   * Work unit 11E-4 (extended in 11F-1): lists `Series` rows, ordered
   * deterministically by `sortOrder` then `id`, matching the existing
   * `AdminMediaService.list`/public-feed ordering convention
   * (`VideosService.findAll`). No pagination — the frozen contract marks it
   * optional and not required, and there is no expected row-count pressure
   * here (one row per curated series, not per episode).
   *
   * Archived rows (`archivedAt` non-null) are EXCLUDED by default — safe
   * archive is the primary "delete" action, so a plain list should read
   * like an "active series" view. Passing `includeArchived=true` includes
   * them alongside active rows, still in the same deterministic order.
   *
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 5: every row (archived or not, episode-less or not — this route never
   * reads `Video` at all) gets a signed `coverUrl` resolved the same way
   * the public `GET /series` surface does.
   */
  async list(
    query: ListAdminSeriesQueryDto = {},
  ): Promise<SeriesWithCoverDto[]> {
    const rows = await this.prisma.series.findMany({
      where: query.includeArchived === true ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    return Promise.all(rows.map((row) => this.toSeriesWithCoverDto(row)));
  }

  /**
   * Work unit 11F-1: `GET /admin/series/:id` read-detail. Returns an
   * archived series too (unlike `list`'s default exclusion) — a caller that
   * already has the id (e.g. from an `includeArchived=true` list, or one
   * they created themselves) can always look it up directly; only the
   * *default* list view hides archived rows.
   *
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": also includes a
   * signed `coverUrl`, same as `list` above.
   */
  async findById(id: string): Promise<SeriesWithCoverDto> {
    return this.toSeriesWithCoverDto(await this.findSeriesOrThrow(id));
  }

  /**
   * Work unit 11E-4: creates a new `Series` row. `dto.id` is
   * client-provided (see `CreateSeriesDto`'s class doc). A pre-check via
   * `findUnique` mirrors the existing `AuthService.register`/
   * `EMAIL_ALREADY_REGISTERED` precedent for a clean, structured duplicate
   * error; the `try`/`catch` around the `create` call below is an
   * additional defense-in-depth layer against the narrow race window
   * between the pre-check and the write (two concurrent admin requests
   * creating the same id), translating a raw Postgres unique-constraint
   * violation (`P2002`) into the same clean `AppException` rather than
   * letting it surface as an unstructured 500.
   */
  async create(dto: CreateSeriesDto): Promise<SeriesDto> {
    const existing = await this.prisma.series.findUnique({
      where: { id: dto.id },
    });

    if (existing) {
      throw seriesAlreadyExists();
    }

    try {
      const created = await this.prisma.series.create({
        data: {
          id: dto.id,
          title: dto.title,
          coverImageKey: dto.coverImageKey ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });

      return toSeriesDto(created);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw seriesAlreadyExists();
      }
      throw error;
    }
  }

  /**
   * Work unit 11E-4: a partial metadata edit. Validates the "at least one
   * field" rule before touching the database (a pure request-validation
   * concern — `UpdateSeriesDto` cannot express it declaratively), then 404s
   * via `findSeriesOrThrow` for an unknown id, then writes only the
   * whitelisted fields present in the body. `id`/`createdAt` are never
   * touched; `updatedAt` is bumped automatically by Prisma's `@updatedAt`.
   *
   * Fix cycle 1 (2026-08-15): an explicit `coverImageKey: null` ALSO clears
   * `pendingCoverImageKey` in the SAME write — see that column's schema doc
   * comment. Rationale: an explicit clear is a deliberate admin action
   * declaring "this series has no cover right now"; any upload that was
   * still in flight when that happened is invalidated along with it, so a
   * later stale/replayed `POST .../cover/complete` for that abandoned key
   * has nothing left to match and is rejected (`SERIES_COVER_KEY_SUPERSEDED`)
   * rather than silently un-clearing the cover. A `coverImageKey` PATCH to a
   * non-null string, or an omitted `coverImageKey`, never touches
   * `pendingCoverImageKey` — only the explicit-`null` case does.
   *
   * Slice "SERIES COVER UPLOAD CONCURRENCY / TOCTOU HARDENING"
   * (2026-08-18): both columns are cleared by ONE `UPDATE` statement (the
   * single `prisma.series.update` below carries both fields), so there is
   * no observable intermediate state in which the cover has been removed
   * but an in-flight completion still holds a matching pending intent —
   * the removal and the invalidation of outstanding upload intent commit
   * together or not at all. Combined with `completeCoverUpload`'s
   * compare-and-set on `pendingCoverImageKey`, this is what makes
   * "Remove wins over an in-flight completion" deterministic: once this
   * statement commits, every completion still verifying an older key
   * matches 0 rows and can no longer resurrect the cover it uploaded.
   */
  async update(id: string, dto: UpdateSeriesDto): Promise<SeriesDto> {
    const data = buildUpdateData(dto);

    if (Object.keys(data).length === 0) {
      throw new AppException(
        AppErrorCode.EMPTY_SERIES_UPDATE,
        'At least one field must be provided',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.findSeriesOrThrow(id);

    const writeData: SeriesWriteData = { ...data };
    if (dto.coverImageKey === null) {
      writeData.pendingCoverImageKey = null;
    }

    const updated = await this.prisma.series.update({
      where: { id },
      data: writeData,
    });

    return toSeriesDto(updated);
  }

  /**
   * Work unit 11F-1: safe (soft) archive — the PRIMARY "delete" action.
   * Sets `archivedAt` to now; idempotent by construction — if the series is
   * already archived, this returns the row UNCHANGED (no second write, no
   * `archivedAt` timestamp drift, no `updatedAt` bump) rather than
   * re-stamping it on every repeated call. 404s via `findSeriesOrThrow` for
   * an unknown id.
   */
  async archive(id: string): Promise<SeriesDto> {
    const series = await this.findSeriesOrThrow(id);

    if (series.archivedAt !== null) {
      return toSeriesDto(series);
    }

    const updated = await this.prisma.series.update({
      where: { id },
      data: { archivedAt: new Date() },
    });

    return toSeriesDto(updated);
  }

  /**
   * Work unit 11F-1: reverses `archive` by clearing `archivedAt`.
   * Idempotent by the same construction as `archive` — if the series is
   * already active (not archived), this returns the row UNCHANGED. 404s via
   * `findSeriesOrThrow` for an unknown id.
   */
  async unarchive(id: string): Promise<SeriesDto> {
    const series = await this.findSeriesOrThrow(id);

    if (series.archivedAt === null) {
      return toSeriesDto(series);
    }

    const updated = await this.prisma.series.update({
      where: { id },
      data: { archivedAt: null },
    });

    return toSeriesDto(updated);
  }

  /**
   * Work unit 11F-1: the guarded HARD delete — actually removes the
   * `Series` metadata row. 404s via `findSeriesOrThrow` for an unknown id.
   * Before deleting, counts `Video` rows sharing this `seriesId` that are
   * currently `lifecycleState: "published"`; if that count is greater than
   * zero, the delete is REFUSED with a 409 (`SERIES_HAS_PUBLISHED_EPISODES`)
   * and NOTHING is written. This is the only place in this service that
   * reads the `Video` table, and it is read-only (a `count`) — deleting a
   * `Series` row NEVER touches, updates, or deletes any `Video` row, so an
   * episode's `seriesId` and every other field are preserved exactly,
   * whether or not the delete itself succeeds. Archived series are deletable
   * too (archive state does not affect this check) as long as they have no
   * published episodes.
   */
  async remove(id: string): Promise<void> {
    await this.findSeriesOrThrow(id);

    const publishedEpisodeCount = await this.prisma.video.count({
      where: { seriesId: id, lifecycleState: MediaLifecycleState.PUBLISHED },
    });

    if (publishedEpisodeCount > 0) {
      throw new AppException(
        AppErrorCode.SERIES_HAS_PUBLISHED_EPISODES,
        'Series has published episodes and cannot be deleted',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.series.delete({ where: { id } });
  }

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 1: `POST /admin/series/:id/cover` — presign-init. 404s via
   * `findSeriesOrThrow` for an unknown series (checked BEFORE anything else
   * — no presigned URL is ever minted for a series that doesn't exist).
   * The object key is entirely SERVER-generated
   * (`buildSeriesCoverObjectKey`, traversal-proof and per-upload versioned
   * — see that function's doc comment); the client never chooses a key.
   * Deliberately does NOT write `Series.coverImageKey` (or any other
   * PUBLIC/served column) here — a presign alone proves nothing about what,
   * if anything, ever gets uploaded to that URL. `Series.coverImageKey` is
   * set only by `completeCoverUpload` below, and only after independent
   * verification.
   *
   * Fix cycle 1 (2026-08-15, closing a reviewer-reproduced HIGH finding):
   * DOES persist the freshly minted key into `Series.pendingCoverImageKey`
   * — overwriting any prior pending value, so the LATEST mint always wins
   * (see that column's schema doc comment). This does NOT violate the
   * "no `coverImageKey` persistence on presign" guarantee above: the
   * PUBLIC `coverImageKey` (and the `coverUrl` every read surface derives
   * from it) is a completely separate column, left untouched by this write.
   * `pendingCoverImageKey` records upload INTENT only — an internal
   * bookkeeping value `completeCoverUpload` verifies a caller's `key`
   * against, never exposed on `SeriesDto`/`SeriesWithCoverDto` and never
   * itself treated as "the cover". Mirrors the 11P
   * `TranscodeIntentService.recordIntent` precedent of durably recording
   * intent ahead of the actual work completing.
   */
  async createCoverUpload(
    id: string,
    dto: CreateSeriesCoverUploadDto,
  ): Promise<CreateSeriesCoverUploadResponseDto> {
    await this.findSeriesOrThrow(id);

    const objectKey = buildSeriesCoverObjectKey(id);
    const presigned = await this.storageService.createPresignedPutUrl(
      objectKey,
      { contentType: dto.contentType },
    );

    await this.prisma.series.update({
      where: { id },
      data: { pendingCoverImageKey: objectKey },
    });

    return {
      upload: {
        url: presigned.url,
        key: presigned.key,
        expiresAt: presigned.expiresAt.toISOString(),
      },
    };
  }

  /**
   * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT", acceptance criterion
   * 2: `POST /admin/series/:id/cover/complete`.
   *
   * Fix cycle 1 (2026-08-15, closing a reviewer-reproduced HIGH finding):
   * a reviewer proved that, because nothing was persisted at presign time,
   * ANY previously-minted key for this series — including one from a
   * generation that was already successfully replaced, or one whose cover
   * was since explicitly cleared via `PATCH { coverImageKey: null }` —
   * stayed completable FOREVER, since the original checks below only ever
   * verified key-shape-ownership + real object existence, never the key's
   * CURRENCY. A stale/replayed `complete` call could therefore silently
   * revert a legitimate replace, or silently un-clear an explicit null.
   * `Series.pendingCoverImageKey` (see its schema doc comment) closes this:
   * `dto.key` is now checked against a durable, server-recorded intent
   * BEFORE any storage call, not trusted on shape alone.
   *
   * Checks, in order, BEFORE any database write:
   *
   * 1. The series must exist (`findSeriesOrThrow`, 404).
   * 2. `dto.key` must have the exact shape of a key THIS series' presign
   *    step would have minted (`isValidSeriesCoverObjectKey`) — rejects a
   *    key belonging to another series, an `admin-media/...` object, or
   *    any other crafted string, before ever calling out to storage or
   *    touching the two checks below (`400 SERIES_COVER_KEY_INVALID`).
   * 3. **Currency check (fix cycle 1):** `dto.key` must equal EITHER the
   *    series' current `pendingCoverImageKey` (the normal path — this is
   *    the most recently minted, still-in-flight upload; verification
   *    proceeds below) OR its current `coverImageKey` (an idempotent
   *    re-complete of the already-live cover — an immediate no-op success,
   *    no re-verification, no re-write). Any OTHER well-formed key —
   *    real shape, but neither the current intent nor the current live
   *    cover — is a superseded/stale key from an earlier generation and is
   *    rejected outright with `409 SERIES_COVER_KEY_SUPERSEDED`; this is
   *    what makes a replay of an old `complete` call harmless instead of a
   *    silent revert/un-clear.
   * 4. The object must actually exist at that key (`StorageService
   *    .headObject`, the same HEAD-verification mechanism
   *    `AdminMediaService.completeUpload`'s 11L-B3 hardening already
   *    established for the video-source upload flow).
   * 5. The object's REAL, R2-reported `Content-Type` and `Content-Length`
   *    (never the client's own say-so at presign time) must be within the
   *    allowed MIME set / size bound.
   *
   * Only once every check passes does this persist `Series.coverImageKey`
   * — in the SAME write, `pendingCoverImageKey` is cleared back to `null`
   * (this generation's intent has now been fulfilled).
   *
   * Slice "SERIES COVER UPLOAD CONCURRENCY / TOCTOU HARDENING"
   * (2026-08-18): that final write is itself CONDITIONAL — an atomic
   * compare-and-set on `pendingCoverImageKey`, not an unconditional
   * `update({ where: { id } })`. Check 3 above compares `dto.key` against a
   * row read BEFORE the `headObject` round-trip, so it can only prove the
   * intent was current at READ time; between that read and the write — a
   * window as wide as a real network HEAD against R2 — another admin
   * action can supersede this completion (`PATCH { coverImageKey: null }`
   * removing the cover, or a fresh `POST .../cover` minting a replacement
   * intent). An unconditional final update would let the now-stale
   * completion win ANYWAY, resurrecting a just-removed cover or reverting a
   * newer intent. Putting `pendingCoverImageKey: dto.key` in the write's
   * own `WHERE` clause makes the database — not a JS comparison against a
   * stale read — the authority on whether this completion still owns the
   * current intent at the exact write moment. A completion that loses that
   * compare-and-set writes NOTHING; see `resolveLostCoverCasOutcome`.
   *
   * Any failure at check 4 or 5 leaves BOTH `coverImageKey` AND
   * `pendingCoverImageKey` untouched — the upload can still be retried
   * against the same pending key (e.g. a slow/eventually-consistent R2
   * PUT) without re-presigning.
   */
  async completeCoverUpload(
    id: string,
    dto: CompleteSeriesCoverUploadDto,
  ): Promise<SeriesWithCoverDto> {
    const series = await this.findSeriesOrThrow(id);

    if (!isValidSeriesCoverObjectKey(id, dto.key)) {
      throw seriesCoverKeyInvalid();
    }

    if (dto.key === series.coverImageKey) {
      // Idempotent re-complete of the already-live cover: success,
      // deliberately WITHOUT re-verifying storage or re-writing the row —
      // this key already passed every check the first time it was
      // completed.
      return this.toSeriesWithCoverDto(series);
    }

    if (dto.key !== series.pendingCoverImageKey) {
      // Well-formed for this series, but neither the current pending
      // upload nor the current live cover: a superseded/stale/replayed key.
      throw seriesCoverKeySuperseded();
    }

    const metadata = await this.storageService.headObject(dto.key);

    if (metadata === null) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'No object was found at the presigned upload key',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!isAllowedCoverContentType(metadata.contentType)) {
      throw seriesCoverContentTypeNotAllowed(metadata.contentType);
    }

    if (!isWithinCoverSizeBound(metadata.contentLength)) {
      throw seriesCoverSizeOutOfBound(metadata.contentLength);
    }

    // The ATOMIC compare-and-set described in this method's doc comment.
    // `pendingCoverImageKey: dto.key` in the `WHERE` clause is what makes
    // "this completion still owns the series' current upload intent" a
    // condition Postgres evaluates at the instant of the write, mirroring
    // the conditional-`updateMany` CAS precedent `AuthService.refresh`/
    // `AuthService.revokeSession` already established for the same
    // check-then-act problem on `Session.revokedAt`.
    //
    // `updateManyAndReturn` rather than `updateMany` + `count` purely
    // because this route must RETURN the persisted row: it is the SAME
    // single conditional `UPDATE`, with a `RETURNING` clause, so the row
    // handed to `toSeriesWithCoverDto` below is exactly the state this
    // statement wrote — not a follow-up read that could observe some
    // newer, unrelated write and report it as this call's result.
    const promoted = await this.prisma.series.updateManyAndReturn({
      where: { id, pendingCoverImageKey: dto.key },
      data: { coverImageKey: dto.key, pendingCoverImageKey: null },
    });

    if (promoted.length === 0) {
      return this.resolveLostCoverCasOutcome(id, dto.key);
    }

    return this.toSeriesWithCoverDto(promoted[0]);
  }

  /**
   * Slice "SERIES COVER UPLOAD CONCURRENCY / TOCTOU HARDENING": decides
   * what a completion that LOST `completeCoverUpload`'s compare-and-set
   * gets back. Zero matched rows means the series' `pendingCoverImageKey`
   * was no longer `key` at the write moment — something superseded this
   * completion while it was verifying: a `PATCH { coverImageKey: null }`
   * removal, a newer `POST .../cover` intent, or a concurrent completion of
   * this very same key. This method NEVER writes, so a loser cannot
   * resurrect a removed cover, cannot revert a newer cover, and —
   * critically — cannot clear the replacement intent that beat it.
   *
   * The disposition is deliberately the SAME rule `completeCoverUpload`'s
   * pre-storage currency check (check 3) applies, merely re-evaluated
   * against FRESH state, so no second, competing contract exists for one
   * semantic state:
   *
   * - the series' cover is now exactly `key` → an equivalent completion
   *   for this key already won, so this returns the same `200` no-op
   *   success a SEQUENTIAL duplicate `complete` has always returned.
   *   Interleaving must not change the answer to "I completed key X, and
   *   key X is the live cover"; a client retrying an identical completion
   *   would otherwise get a bewildering conflict for an outcome it did in
   *   fact achieve.
   * - anything else (cover removed, or replaced by a different/newer key)
   *   → the superseded case, answered with the SAME
   *   `409 SERIES_COVER_KEY_SUPERSEDED` a key already known stale BEFORE
   *   the storage call gets.
   *
   * A series deleted out from under an in-flight completion surfaces as
   * `findSeriesOrThrow`'s `404 SERIES_NOT_FOUND` — truthful for a row
   * that no longer exists, and still not a write.
   */
  private async resolveLostCoverCasOutcome(
    id: string,
    key: string,
  ): Promise<SeriesWithCoverDto> {
    const current = await this.findSeriesOrThrow(id);

    if (current.coverImageKey === key) {
      return this.toSeriesWithCoverDto(current);
    }

    throw seriesCoverKeySuperseded();
  }

  private async findSeriesOrThrow(id: string): Promise<SeriesRow> {
    const series = await this.prisma.series.findUnique({ where: { id } });

    if (!series) {
      throw new AppException(
        AppErrorCode.SERIES_NOT_FOUND,
        'Series not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return series;
  }

  private async toSeriesWithCoverDto(
    record: SeriesRow,
  ): Promise<SeriesWithCoverDto> {
    return {
      ...toSeriesDto(record),
      coverUrl: await resolveSeriesCoverUrl(
        this.storageService,
        this.coverUrlContext,
        record,
      ),
    };
  }
}

function seriesAlreadyExists(): AppException {
  return new AppException(
    AppErrorCode.SERIES_ALREADY_EXISTS,
    'A series with this id already exists',
    HttpStatus.CONFLICT,
  );
}

/**
 * Work unit "SERIES COVER UPLOAD BACKEND CONTRACT": `dto.key` did not have
 * the exact `admin-series/<this series' id>/cover/<uuid>` shape — either it
 * belongs to a different series/object entirely, or it is malformed. A
 * request-shape problem (400), not a storage-state conflict.
 */
function seriesCoverKeyInvalid(): AppException {
  return new AppException(
    AppErrorCode.SERIES_COVER_KEY_INVALID,
    'The provided key does not belong to this series’ cover upload prefix',
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * The message intentionally states only the mismatch itself (which MIME
 * types are actually allowed) — never the bucket, endpoint, or key —
 * mirroring `AppErrorCode.UPLOAD_CONTENT_TYPE_MISMATCH`'s established
 * no-leak precedent (`AdminMediaService.completeUpload`, work unit 11L-B3).
 */
function seriesCoverContentTypeNotAllowed(
  contentType: string | undefined,
): AppException {
  return new AppException(
    AppErrorCode.SERIES_COVER_CONTENT_TYPE_NOT_ALLOWED,
    `Uploaded object content type "${contentType ?? 'unknown'}" is not one ` +
      `of the allowed cover image types (${ALLOWED_SERIES_COVER_CONTENT_TYPES.join(', ')})`,
    HttpStatus.CONFLICT,
  );
}

function seriesCoverSizeOutOfBound(contentLength: number): AppException {
  return new AppException(
    AppErrorCode.SERIES_COVER_SIZE_OUT_OF_BOUND,
    `Uploaded object size (${contentLength} bytes) is outside the allowed ` +
      `cover image size bound (1–${MAX_SERIES_COVER_UPLOAD_BYTES} bytes)`,
    HttpStatus.CONFLICT,
  );
}

/**
 * Fix cycle 1 (2026-08-15): `dto.key` had the exact shape a presign for THIS
 * series would produce, but matched neither the series' current
 * `pendingCoverImageKey` nor its current `coverImageKey` — a
 * superseded/stale/replayed key from an earlier generation (see
 * `completeCoverUpload`'s doc comment, check 3). The message intentionally
 * never echoes the key itself or any storage detail, matching the
 * no-leak precedent every other error helper in this file already follows.
 */
function seriesCoverKeySuperseded(): AppException {
  return new AppException(
    AppErrorCode.SERIES_COVER_KEY_SUPERSEDED,
    'This upload key is no longer current for this series — it was ' +
      'superseded by a later upload or cover change; re-presign a new ' +
      'upload to try again',
    HttpStatus.CONFLICT,
  );
}

function isAllowedCoverContentType(
  contentType: string | undefined,
): contentType is AllowedSeriesCoverContentType {
  return (
    contentType !== undefined &&
    (ALLOWED_SERIES_COVER_CONTENT_TYPES as readonly string[]).includes(
      contentType,
    )
  );
}

function isWithinCoverSizeBound(contentLength: number): boolean {
  return contentLength >= 1 && contentLength <= MAX_SERIES_COVER_UPLOAD_BYTES;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

/**
 * Work unit 11E-4: narrows an `UpdateSeriesDto` down to a Prisma `data`
 * object containing only the fields the caller actually provided
 * (`undefined` entries are skipped, not written as explicit nulls) —
 * iterating `UPDATABLE_SERIES_FIELDS` rather than `Object.keys(dto)` means
 * this can never write a field outside that whitelist, mirroring
 * `AdminMediaService.buildMetadataUpdateData`'s precedent.
 */
function buildUpdateData(dto: UpdateSeriesDto): SeriesUpdateData {
  const data: SeriesUpdateData = {};

  for (const field of UPDATABLE_SERIES_FIELDS) {
    const value = dto[field];
    if (value !== undefined) {
      (data as Record<UpdatableSeriesField, unknown>)[field] = value;
    }
  }

  return data;
}

function toSeriesDto(record: SeriesRow): SeriesDto {
  return {
    id: record.id,
    title: record.title,
    coverImageKey: record.coverImageKey,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
  };
}
