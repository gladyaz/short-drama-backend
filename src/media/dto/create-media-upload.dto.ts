import { VideoContentKind } from '../../videos/video-content-kind.types';
import { VIDEO_CATEGORIES } from '../../videos/video-category.constants';
import type { VideoCategory } from '../../videos/video-category.constants';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { MAX_UPLOAD_BYTES } from '../media-upload.constants';

/**
 * Work unit 11L-B2: the single content type this route accepts. A closed
 * one-value allow-list (not a general MIME whitelist) — matching
 * `phases/phase-11-slice-11L-PLAN.md` §9's "MIME allow-list of one" security
 * control. Exported so `CreateMediaUploadDto.contentType`'s `@IsIn` and any
 * future caller that needs to compare against the same value never drift.
 */
export const ALLOWED_UPLOAD_CONTENT_TYPES = ['video/mp4'] as const;

/**
 * Body of `POST /admin/media` (work unit 11B-3, hardened by 11L-B2):
 * metadata for a new media record, created in the `draft` lifecycle state
 * alongside a presigned upload URL. Mirrors `VideoRecord`'s required fields
 * (see `video.types.ts`) minus `id`/`storageKey` (generated server-side) and
 * `likeCount` (always starts at 0).
 *
 * Work unit 11L-B2 provenance: `sizeBytes` and `contentType` are the
 * client's DECLARED upload expectation, persisted verbatim onto
 * `Video.expectedSizeBytes`/`expectedContentType` (11L-B1) by
 * `AdminMediaService.createUpload` — NOT re-derived from anything else on
 * this DTO. They exist so `POST /admin/media/:id/complete-upload` (11L-B3)
 * has a server-recorded value to verify R2's own `HeadObject` response
 * against, one the completing caller cannot restate. `contentType` is
 * intentionally no longer optional/free-form (see the 11B-3 version's doc
 * comment, "passed through ... if provided") — this slice narrows it to
 * exactly one allowed value (`ALLOWED_UPLOAD_CONTENT_TYPES`) precisely
 * because it is now a security-relevant expectation, not a passthrough
 * convenience.
 */
export class CreateMediaUploadDto {
  @IsString()
  @Length(1, 200)
  seriesId!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsInt()
  @Min(1)
  episodeNumber!: number;

  @IsString()
  @Length(1, 200)
  channelName!: string;

  @IsString()
  @Length(1, 2000)
  caption!: string;

  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening": narrowed
   * from freeform (`@IsString() @Length(1, 100)`) to a closed set —
   * `VIDEO_CATEGORIES` (`videos/video-category.constants.ts`), this
   * backend's own audited canonical categories. An unrecognised value is now
   * rejected with a clean `400` instead of silently entering the database.
   */
  @IsIn(VIDEO_CATEGORIES)
  category!: VideoCategory;

  @IsString()
  @Length(1, 20)
  sourceLanguage!: string;

  @IsBoolean()
  hasEmbeddedIndonesianSubtitle!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  /**
   * Work unit 11L-B2: the size, in bytes, the client declares it is about
   * to `PUT` to the presigned URL. REQUIRED (unlike every other field on
   * this DTO that predates this slice) — the whole point of this field is
   * that `completeUpload` (11L-B3) has something server-recorded to check
   * R2's `HeadObject` `ContentLength` against, so an unset value would
   * defeat the purpose. Bounded to `MAX_UPLOAD_BYTES` (see that constant's
   * doc comment for why it is one byte under a literal 2 GiB) — a single
   * presigned `PUT`, no multipart upload exists in this codebase.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  sizeBytes!: number;

  /**
   * Work unit 11L-B2: narrowed from optional/free-form to REQUIRED and
   * restricted to exactly `ALLOWED_UPLOAD_CONTENT_TYPES` (currently just
   * `'video/mp4'`) — this route only ever accepts one content type, so
   * accepting anything else here would let a caller mint a presigned PUT
   * URL, and record an "expectation", for a file type this pipeline was
   * never built to serve.
   */
  @IsIn(ALLOWED_UPLOAD_CONTENT_TYPES)
  contentType!: string;

  /**
   * Explicit catalog classification for the row this upload creates.
   *
   * Optional: omitting it falls through to the `Video.contentKind` column
   * default (`drama`), which is right for real content and keeps every
   * existing caller working unchanged. It exists so an INTERNAL fixture can
   * declare itself at creation time - the alternative is what this contract
   * was introduced to end, a synthetic row indistinguishable from a real
   * drama that can only be corrected with raw SQL.
   */
  @IsOptional()
  @IsIn(Object.values(VideoContentKind))
  contentKind?: VideoContentKind;
}
