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
