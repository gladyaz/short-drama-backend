/**
 * Slice 11Q — Private HLS Delivery Gateway (control-workspace DECISIONS.md
 * "2026-08-10 — Slice 11Q APPROVED..." entry; architecture:
 * proposals/phase-11-hls-pipeline-proposal.md §9/§9a).
 *
 * Deliberately NOT the full ambient `R2Bucket`/`R2ObjectBody` types from
 * `@cloudflare/workers-types` — this gateway is READ-ONLY (it only ever
 * calls `.get()`), so it declares its own narrow structural subset instead
 * of requiring every test double to implement R2's full surface (head,
 * put, delete, list, multipart upload, etc., none of which this Worker
 * ever calls). A real Cloudflare `R2Bucket` binding satisfies this
 * interface structurally (its `.get()` accepts a strict superset of the
 * options this interface requires and returns an object with a strict
 * superset of the fields this interface requires) — no adapter/wrapper is
 * needed at real-deploy time, only at that point has this been exercised
 * against the ambient `R2Bucket` type itself (out of scope for this
 * credential-free, non-deployed slice).
 */

/** A single, resolved (never open-ended) byte range of an object's TOTAL size. */
export interface MediaObjectRange {
  offset: number;
  length: number;
}

/**
 * The range shape a real R2 `.get()` RESPONSE may carry (`R2Object.range`).
 * Faithfully mirrors the ambient `R2Range` union from
 * `@cloudflare/workers-types` — any of the three variants may come back,
 * with `offset`/`length` individually optional. 11Q-A1's workers-types
 * compile gate (workers-types-compat.ts) proved the previous concrete
 * `{offset, length}` shape was NOT what the real API declares; the honest
 * fix is to model the real union here and resolve it against the object's
 * total size in `resolveReturnedRange` (range.ts) — never to assume both
 * fields are present.
 */
export type MediaObjectReturnedRange =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

/**
 * The shape this gateway needs from an R2 `.get()` response. `size` is
 * ALWAYS the object's total size (matching real R2Object semantics),
 * regardless of whether this particular read was ranged — `range`, when
 * present, describes which slice `body` contains, in the real API's own
 * (union) terms; use `resolveReturnedRange` to obtain concrete
 * offset/length before building `Content-Range`.
 */
export interface MediaObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  range?: MediaObjectReturnedRange;
}

/**
 * A REQUESTED range, mirroring the real `R2Bucket.get()` `range` option's
 * union shape (`{offset, length?}` or `{suffix}`) — deliberately not just
 * `{offset, length}`, since an open-ended (`bytes=500-`) or suffix
 * (`bytes=-500`) Range header cannot be resolved into a concrete `length`
 * without already knowing the object's total size, which is exactly what
 * the bucket itself resolves this against.
 */
export type MediaObjectRangeRequest =
  | { offset: number; length?: number }
  | { suffix: number };

export interface MediaBucket {
  get(
    key: string,
    options?: { range?: MediaObjectRangeRequest },
  ): Promise<MediaObject | null>;
}

/**
 * Slice 11Q §9a — CACHE AMENDMENT. Deliberately narrow (`match`/`put` only)
 * — a structural subset of the real Workers `Cache` interface
 * (`caches.default`), so a plain in-memory fake can be injected in tests
 * without implementing `delete`/etc. this gateway never calls.
 */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface Env {
  MEDIA_BUCKET: MediaBucket;
  /**
   * Dedicated HLS token signing secret — the HMAC key shared with the
   * backend's `HLS_TOKEN_SECRET`. Never logged, never echoed in any
   * response body (see index.ts's uniform, detail-free 403/404 responses).
   */
  HLS_TOKEN_SECRET: string;
  /**
   * Slice 11Q §9a: must be the EXACT string `"true"` to activate the cache
   * layer — fail-closed, mirroring the backend's `TRANSCODE_ENABLED`/
   * `STORAGE_DRIVER` exact-string convention. Absent, `"false"`, `"1"`,
   * `"TRUE"`, or any other value all mean DISABLED. This slice never ships
   * a real deployment with this set to `"true"` (no real deployment exists
   * yet at all — see `wrangler.toml.example`).
   */
  CACHE_ENABLED?: string;
}
