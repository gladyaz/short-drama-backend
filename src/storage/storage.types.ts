/**
 * Phase 11, work unit 11A-1: the minimal S3-compatible client surface that
 * `StorageService` actually calls at runtime (`send()`, used by every AWS
 * SDK v3 client command). `StorageService`'s constructor is typed against
 * the concrete `S3Client` class (required by `getSignedUrl`'s signature),
 * but tests only ever need to satisfy this narrower interface: a plain
 * `{ send: jest.fn() }` object cast `as unknown as S3Client` is a fully
 * valid, no-network mock because `S3Client` is never actually constructed
 * or inspected beyond calling `.send()`.
 */
export interface S3CompatibleClient {
  send(command: unknown): Promise<unknown>;
}

export interface PresignedUrlResult {
  url: string;
  key: string;
  expiresAt: Date;
}

export interface CreatePresignedPutUrlOptions {
  contentType?: string;
  expiresInSeconds?: number;
}

export interface CreatePresignedGetUrlOptions {
  expiresInSeconds?: number;
}

export interface StorageObjectMetadata {
  key: string;
  contentLength: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
}

/**
 * Slice 11P: one entry returned by `StorageService.listObjectKeysByPrefix` —
 * `lastModified` is whatever `ListObjectsV2` itself reports (absent only in
 * a degenerate/mocked response), never independently fetched via a second
 * HEAD call.
 */
export interface ObjectListEntry {
  key: string;
  lastModified?: Date;
}

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": options for
 * `StorageService.listObjectPageByPrefix` — ONE page of a `ListObjectsV2`
 * enumeration. `continuationToken` is whatever the PREVIOUS page returned as
 * `nextContinuationToken`; omitting it starts at the beginning of `prefix`.
 */
export interface ListObjectPageOptions {
  maxKeys?: number;
  continuationToken?: string;
}

/**
 * Slice "SERIES COVER ORPHAN CLEANUP LIFECYCLE": one page of a prefix
 * enumeration. `nextContinuationToken` is present ONLY when the provider
 * reported the listing as truncated AND handed back a usable token — a
 * caller loops while it is present (under its own page bound) and stops the
 * instant it is `undefined`, which is what makes "no infinite listing loop"
 * a property of the return shape rather than of caller discipline alone.
 */
export interface ObjectListPage {
  entries: ObjectListEntry[];
  nextContinuationToken?: string;
}
