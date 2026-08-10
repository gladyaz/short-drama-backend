import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { RootConfig, StorageConfig } from '../config/configuration';
import {
  DEFAULT_GET_URL_EXPIRY_SECONDS,
  DEFAULT_LIST_MAX_KEYS,
  DEFAULT_PUT_URL_EXPIRY_SECONDS,
  S3_CLIENT,
} from './storage.constants';
import {
  CreatePresignedGetUrlOptions,
  CreatePresignedPutUrlOptions,
  ObjectListEntry,
  PresignedUrlResult,
  StorageObjectMetadata,
} from './storage.types';

/**
 * Phase 11, work unit 11A-1: provider-agnostic object storage client. The
 * constructor is typed against the concrete `S3Client` class (required by
 * `getSignedUrl`'s signature), but the actual client is resolved via the
 * `S3_CLIENT` DI token, not constructed here — `StorageModule` provides a
 * real `S3Client` configured for Cloudflare R2 (the approved target
 * provider — see DECISIONS.md "Phase 11 (Production Media Storage...)
 * approved..." entry), while unit tests provide a plain
 * `{ send: jest.fn() }` mock cast to `S3Client` (see
 * `storage.types.ts::S3CompatibleClient`) and never touch the network.
 * Nothing in this credential-free slice wires this service to a route that
 * would make a real S3/R2 call.
 */
@Injectable()
export class StorageService {
  private readonly storageConfig: StorageConfig;

  constructor(
    private readonly configService: ConfigService<RootConfig>,
    @Inject(S3_CLIENT) private readonly client: S3Client,
  ) {
    this.storageConfig = this.configService.get('storage', { infer: true })!;
  }

  /**
   * Presigned URL a client can `PUT` an object to directly, without the
   * object ever passing through this backend. Used by 11B-3's
   * create-upload flow.
   */
  async createPresignedPutUrl(
    key: string,
    options?: CreatePresignedPutUrlOptions,
  ): Promise<PresignedUrlResult> {
    const expiresInSeconds =
      options?.expiresInSeconds ?? DEFAULT_PUT_URL_EXPIRY_SECONDS;

    const command = new PutObjectCommand({
      Bucket: this.storageConfig.bucket,
      Key: key,
      ContentType: options?.contentType,
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
    });

    return {
      url,
      key,
      expiresAt: secondsFromNow(expiresInSeconds),
    };
  }

  /** Presigned URL a client can `GET` (download/stream) an object from. */
  async createPresignedGetUrl(
    key: string,
    options?: CreatePresignedGetUrlOptions,
  ): Promise<PresignedUrlResult> {
    const expiresInSeconds =
      options?.expiresInSeconds ?? DEFAULT_GET_URL_EXPIRY_SECONDS;

    const command = new GetObjectCommand({
      Bucket: this.storageConfig.bucket,
      Key: key,
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
    });

    return {
      url,
      key,
      expiresAt: secondsFromNow(expiresInSeconds),
    };
  }

  /**
   * Returns the object's metadata, or `null` if it does not exist. Used by
   * `objectExists` and by 11B-3's complete-upload flow to confirm an
   * upload actually landed before transitioning a media record out of
   * `draft`.
   */
  async headObject(key: string): Promise<StorageObjectMetadata | null> {
    try {
      const result = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.storageConfig.bucket,
          Key: key,
        }),
      )) as {
        ContentLength?: number;
        ContentType?: string;
        LastModified?: Date;
        ETag?: string;
      };

      return {
        key,
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType,
        lastModified: result.LastModified,
        etag: result.ETag,
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.storageConfig.bucket,
        Key: key,
      }),
    );
  }

  /**
   * Phase 11, work unit 11D-2b: uploads `body` directly through this
   * backend (unlike `createPresignedPutUrl`'s direct-to-client flow) — used
   * by `ThumbnailService` to ingest a small, server-generated thumbnail
   * image. Every test that exercises a caller of this method mocks
   * `StorageService`/its underlying `S3Client`; no real R2/network call is
   * ever made from this credential-free slice.
   */
  async putObject(
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.storageConfig.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Slice 11P — Production Transcoding Lifecycle: downloads an object
   * directly to a local file path (unlike every other method here, which
   * either returns a presigned URL for a CLIENT to use, or reads/writes a
   * small in-memory buffer). Used ONLY by `TranscodeJobProcessor` to fetch
   * `admin-media/<id>/source` into a fresh `fs.mkdtemp` temp directory
   * before probing/transcoding — never `STORAGE_ROOT` (this method has no
   * awareness of that path at all; it only ever writes to a caller-supplied
   * `destPath`, exactly like `ThumbnailService`'s existing temp-directory
   * discipline).
   *
   * The AWS SDK v3 `GetObjectCommand` response's `Body` is a Node.js
   * `Readable` in this runtime (never buffered fully into memory here) —
   * `stream/promises`' `pipeline` streams it directly to `destPath` and
   * rejects if either side errors, so a failed/interrupted download never
   * leaves a corrupt-but-present file silently treated as complete (the
   * caller's own `finally`-block temp cleanup still removes whatever partial
   * bytes did land). Every test that exercises this method injects a mocked
   * `client.send` resolving `{ Body: Readable.from([...]) }` — no real
   * network call.
   */
  async downloadObjectToFile(key: string, destPath: string): Promise<void> {
    const response = (await this.client.send(
      new GetObjectCommand({
        Bucket: this.storageConfig.bucket,
        Key: key,
      }),
    )) as { Body?: NodeJS.ReadableStream };

    if (!response.Body) {
      throw new Error(`GetObject for key "${key}" returned no body`);
    }

    await pipeline(response.Body, createWriteStream(destPath));
  }

  /**
   * Slice 11P: a narrow, BOUNDED (`maxKeys`, default
   * `DEFAULT_LIST_MAX_KEYS`) `ListObjectsV2` wrapper — a single page, never
   * paginated further (a deliberate simplicity/boundedness tradeoff:
   * `TranscodeJanitorService`'s sweep is itself bounded per run and re-runs
   * repeatedly, so a prefix with more than `maxKeys` objects is simply
   * handled across multiple sweeps rather than this method ever looping
   * unboundedly on a single call). Returns `{ key, lastModified }` pairs —
   * `ListObjectsV2` already reports `LastModified` per entry at zero extra
   * cost, which is exactly what the janitor's grace-window "how old is this
   * generation's newest object" check needs without N additional `HeadObject`
   * calls per candidate prefix.
   */
  async listObjectKeysByPrefix(
    prefix: string,
    maxKeys: number = DEFAULT_LIST_MAX_KEYS,
  ): Promise<ObjectListEntry[]> {
    const result = (await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.storageConfig.bucket,
        Prefix: prefix,
        MaxKeys: maxKeys,
      }),
    )) as {
      Contents?: { Key?: string; LastModified?: Date }[];
    };

    return (result.Contents ?? [])
      .filter(
        (entry): entry is { Key: string; LastModified?: Date } =>
          typeof entry.Key === 'string',
      )
      .map((entry) => ({ key: entry.Key, lastModified: entry.LastModified }));
  }

  /**
   * Builds a public CDN URL for `key` from the configured public base URL.
   *
   * Phase 11, work unit 11H-B1: `OBJECT_STORAGE_PUBLIC_BASE_URL` is
   * optional (see `env.validation.ts`'s `REQUIRED_R2_KEYS`) — it is only
   * needed once a public bucket or a custom domain exists to serve public
   * object URLs from. Today's dev R2 bucket is private, `r2.dev` is
   * disabled, and no custom domain exists, so this method has ZERO callers
   * in production code (only its own spec exercises it); presigned
   * PUT/HEAD/GET/DELETE never read `publicBaseUrl` and work regardless.
   * When a base URL IS configured, this method's behavior — including the
   * trailing-slash/leading-slash normalisation below — is unchanged from
   * before this work unit.
   */
  buildPublicUrl(key: string): string {
    const configuredBase = this.storageConfig.publicBaseUrl;

    if (configuredBase === undefined || configuredBase.length === 0) {
      throw new Error(
        'Cannot build a public object URL: OBJECT_STORAGE_PUBLIC_BASE_URL ' +
          'is not configured. This variable is only needed to build ' +
          'public-object URLs (a public bucket or a custom domain) — see ' +
          '.env.example. A private bucket serves objects via presigned ' +
          'PUT/GET URLs instead (createPresignedPutUrl/createPresignedGetUrl), ' +
          'which never call this method.',
      );
    }

    const base = configuredBase.replace(/\/+$/, '');
    const safeKey = key.replace(/^\/+/, '');
    return `${base}/${safeKey}`;
  }
}

function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/**
 * AWS SDK v3 S3 commands reject with a `NotFound`-named error (`name` on
 * `HeadObjectCommand` specifically) or, more generally, a `404` in
 * `$metadata.httpStatusCode` — checked defensively since S3-compatible
 * providers (like R2) do not always populate both identically.
 */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404
  );
}
