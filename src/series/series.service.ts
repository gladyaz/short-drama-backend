import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSeriesDto } from './dto/create-series.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import { SeriesDto } from './series.types';

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
};

/** Postgres unique-violation error code, per Prisma's documented mapping. */
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Phase 11, work unit 11E-4: additive `Series` metadata CRUD (no delete —
 * out of scope). A `Series` row purely ANNOTATES an existing/planned
 * `Video.seriesId` grouping (display title, cover image, manual ordering);
 * it never reads or writes any `Video` row, and no route in this service is
 * reachable from the public API — every method here is called only from
 * `SeriesController`, guarded by `JwtAuthGuard`+`AdminGuard`. The public
 * `/videos/feed` grouping (still computed client-side from `Video.seriesId`)
 * is completely unaffected by anything in this file.
 */
@Injectable()
export class SeriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Work unit 11E-4: lists every `Series` row, ordered deterministically by
   * `sortOrder` then `id`, matching the existing `AdminMediaService.list`/
   * public-feed ordering convention (`VideosService.findAll`). No
   * pagination — the frozen contract marks it optional and not required,
   * and there is no expected row-count pressure here (one row per curated
   * series, not per episode).
   */
  async list(): Promise<SeriesDto[]> {
    const rows = await this.prisma.series.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toSeriesDto);
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

    const updated = await this.prisma.series.update({
      where: { id },
      data,
    });

    return toSeriesDto(updated);
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
}

function seriesAlreadyExists(): AppException {
  return new AppException(
    AppErrorCode.SERIES_ALREADY_EXISTS,
    'A series with this id already exists',
    HttpStatus.CONFLICT,
  );
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
  };
}
