import { HlsRenditionSummary } from '../transcode/transcode.types';
import { AdminMediaIngestionStatus } from './admin-media-status';

/**
 * Work unit "ADMIN MEDIA INGESTION": the admin-facing processing/status
 * block, additive on every `AdminMediaDto` and returned on its own by
 * `GET /admin/media/:id/status`. This is the contract an ingestion
 * dashboard renders "Uploading / Queued / Processing / Ready / Failed"
 * from.
 *
 * SECURITY. Every field here is either a derived status, a bounded
 * machine-stable code, a counter, a timestamp, or an object KEY. It carries
 * NO object-storage credential, NO bucket name, NO endpoint, and NO
 * presigned URL — a status poll must never become a way to obtain upload
 * or download authorization. `hlsMasterKey` is the same class of data as
 * the `objectStorageKey`/`coverImageKey`/`thumbnailImageKey` fields
 * `AdminMediaDto` has always exposed to admins: an opaque key that is
 * useless without separately-held credentials.
 */
export interface AdminMediaProcessingDto {
  /**
   * The derived, dashboard-facing projection of `lifecycleState` +
   * `processingState` — see `deriveIngestionStatus`. This is the ONE field
   * a status badge should switch on.
   */
  status: AdminMediaIngestionStatus;
  /**
   * The RAW `Video.processingState` column, verbatim (`null` for a row no
   * HLS pipeline was ever requested for). Reported next to the derived
   * `status` so an operator can always see the underlying machine value,
   * including one `deriveIngestionStatus` did not recognise.
   */
  state: string | null;
  /**
   * The generation counter (`Video.processingVersion`) every worker CAS is
   * guarded on. Surfaced because it is the only way to tell "still the run
   * I started" from "a newer generation superseded it" when watching a row.
   */
  version: number;
  /**
   * Display-only progress detail within a `running` generation (e.g.
   * `"probing"`, a rung name, `"packaging"`, `"uploading"`, `"verifying"`,
   * `"poster"`). Always `null` outside a run.
   */
  step: string | null;
  /** Attempts made against the CURRENT generation. */
  attempts: number;
  /**
   * `TRANSCODE_MAX_ATTEMPTS` — the cap `attempts` is climbing toward, so a
   * dashboard can render "attempt 2/3" without hardcoding the deployment's
   * configured value. `null` when transcoding is disabled for this
   * deployment (there is no cap to report because no attempt can be made).
   */
  maxAttempts: number | null;
  /**
   * Bounded, machine-stable failure code (`TranscodeErrorCode`) — never a
   * raw exception message or stack trace. Non-null only after a failed (or
   * demoted) generation.
   */
  errorCode: string | null;
  /** Short, secret-free human-readable companion to `errorCode`. */
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * Whether a fully verified, promoted HLS generation currently exists —
   * i.e. `processingState === "ready"` AND `hlsMasterKey` is set. This is
   * exactly the condition `AdminMediaService.assertHlsReadyForPublish`
   * gates publishing on, so a dashboard can explain WHY a Publish button is
   * disabled instead of surfacing a 409 after the fact.
   */
  hlsReady: boolean;
  /** Object key of the current promoted generation's master playlist. */
  hlsMasterKey: string | null;
  /**
   * The renditions actually produced for the CURRENT `hlsMasterKey`
   * generation (`null` before any promotion). Written in the same CAS as
   * `hlsMasterKey`, so the two always describe the same generation.
   */
  renditions: HlsRenditionSummary[] | null;
  /** Which rendition-ladder profile produced the current generation. */
  profileVersion: string | null;
  /**
   * Whether `POST /admin/media/:id/retry-transcode` would accept this row —
   * see `canRetryTranscode` for the exact predicate, and for the one
   * condition (does the source object still exist in R2?) this cannot
   * answer without a network round trip.
   */
  canRetry: boolean;
}

/**
 * Work unit "ADMIN MEDIA INGESTION": response of
 * `GET /admin/media/:id/status` — a deliberately NARROW payload for the one
 * request an ingestion dashboard makes repeatedly (polling a row while it
 * transcodes). It carries the identity and the processing block only, so a
 * poll loop does not re-transfer the full editorial record on every tick.
 * The identical `processing` block is also present on every `AdminMediaDto`,
 * so a dashboard that already holds the full row never needs this route.
 */
export interface AdminMediaStatusDto {
  id: string;
  lifecycleState: string;
  processing: AdminMediaProcessingDto;
}

/**
 * Phase 11, work unit 11B-3: the admin-facing view of a `Video` row —
 * unlike `VideoResponseDto` (the public feed shape, `video.types.ts`),
 * this exposes the object-storage keys and `lifecycleState` an admin needs
 * to track an upload through the pipeline, and never computes a
 * `playbackUrl` (a draft/ready row has no guaranteed streamable file yet).
 */
export interface AdminMediaDto {
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
  /**
   * Work unit 11E-3: the raw per-episode access-tier override, exposed here
   * (the admin-only DTO) and deliberately NOT on the public
   * `VideoResponseDto` in `../videos/video.types.ts` — the public feed shape
   * is unchanged by this work unit. `null` means "no override, use the
   * default `episodeNumber > FREE_EPISODE_LIMIT` rule".
   */
  accessTierOverride: 'free' | 'premium' | null;
  /**
   * Work unit "Episode Access-Tier + Category Contract Hardening":
   * ADDITIVE — the same resolved (effective) tier the public
   * `VideoResponseDto.accessTier` field exposes, computed via the same
   * authoritative `resolveAccessTier` function. Lets an admin see, next to
   * the raw `accessTierOverride`, exactly what the public catalog currently
   * reports for this episode — always in agreement by construction, never a
   * second/duplicated derivation.
   */
  accessTier: 'free' | 'premium';
  /**
   * Work unit "ADMIN MEDIA INGESTION": ADDITIVE — the ingestion/transcoding
   * status block. Purely additive to this DTO: no existing field changed
   * shape or meaning, so every existing consumer keeps working untouched.
   */
  processing: AdminMediaProcessingDto;
}

export interface PresignedUploadDto {
  url: string;
  key: string;
  expiresAt: string;
}

export interface CreateMediaUploadResponseDto {
  media: AdminMediaDto;
  upload: PresignedUploadDto;
}

export interface MediaAssetUploadResponseDto {
  media: AdminMediaDto;
  upload: PresignedUploadDto;
}

/**
 * Response of `GET /admin/media` (work unit 11E-1): a paginated slice of
 * the admin inventory, across ALL lifecycle states (draft/ready/published/
 * unpublished/failed) — unlike the public feed, which only ever returns
 * `published` rows.
 */
export interface AdminMediaListResponseDto {
  items: AdminMediaDto[];
  total: number;
  page: number;
  pageSize: number;
}
