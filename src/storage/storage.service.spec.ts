import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
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
import { RootConfig } from '../config/configuration';
import {
  DEFAULT_GET_URL_EXPIRY_SECONDS,
  DEFAULT_LIST_MAX_KEYS,
  DEFAULT_PUT_URL_EXPIRY_SECONDS,
} from './storage.constants';
import { StorageService } from './storage.service';

/**
 * Phase 11, work unit 11A-1: unit tests run entirely against a MOCKED
 * S3-compatible client — `@aws-sdk/s3-request-presigner`'s `getSignedUrl` is
 * jest-mocked (no real signing/network) and the injected "client" is a
 * plain `{ send: jest.fn() }` object, never a real `S3Client` connection.
 * No test in this file makes a network call.
 */
jest.mock('@aws-sdk/s3-request-presigner');

const TEST_STORAGE_CONFIG: RootConfig['storage'] = {
  driver: 'local',
  endpoint: 'https://mock.r2.example.test',
  region: 'auto',
  bucket: 'mock-bucket',
  accessKeyId: 'mock-access-key-id',
  secretAccessKey: 'mock-secret-access-key',
  publicBaseUrl: 'https://media.example.test',
};

function buildFakeConfigService(
  overrides: Partial<RootConfig['storage']> = {},
): ConfigService<RootConfig> {
  return {
    get: () => ({ ...TEST_STORAGE_CONFIG, ...overrides }),
  } as unknown as ConfigService<RootConfig>;
}

type SendMock = jest.Mock<Promise<unknown>, [unknown]>;

describe('StorageService', () => {
  let mockClient: { send: SendMock };
  let service: StorageService;
  const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
    typeof getSignedUrl
  >;

  beforeEach(() => {
    mockClient = { send: jest.fn<Promise<unknown>, [unknown]>() };
    service = new StorageService(
      buildFakeConfigService(),
      mockClient as unknown as S3Client,
    );
    mockGetSignedUrl.mockReset();
  });

  describe('createPresignedPutUrl', () => {
    it('returns a signed URL, the key, and an expiry derived from the default TTL', async () => {
      // Arrange
      mockGetSignedUrl.mockResolvedValue('https://signed.example.test/put');
      const before = Date.now();

      // Act
      const result = await service.createPresignedPutUrl('videos/abc.mp4');

      // Assert
      expect(result.url).toBe('https://signed.example.test/put');
      expect(result.key).toBe('videos/abc.mp4');
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + DEFAULT_PUT_URL_EXPIRY_SECONDS * 1000,
      );
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      expect(mockGetSignedUrl.mock.calls[0][1]).toBeInstanceOf(
        PutObjectCommand,
      );
      expect(mockGetSignedUrl.mock.calls[0][2]).toEqual({
        expiresIn: DEFAULT_PUT_URL_EXPIRY_SECONDS,
      });
    });

    it('builds the PutObjectCommand against the configured bucket and requested key', async () => {
      // Arrange
      mockGetSignedUrl.mockResolvedValue('https://signed.example.test/put');

      // Act
      await service.createPresignedPutUrl('videos/xyz.mp4', {
        contentType: 'video/mp4',
      });

      // Assert
      const command = mockGetSignedUrl.mock.calls[0][1] as PutObjectCommand;
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'videos/xyz.mp4',
        ContentType: 'video/mp4',
      });
    });

    it('honors a caller-supplied expiresInSeconds override', async () => {
      // Arrange
      mockGetSignedUrl.mockResolvedValue('https://signed.example.test/put');

      // Act
      const result = await service.createPresignedPutUrl('videos/abc.mp4', {
        expiresInSeconds: 120,
      });

      // Assert
      expect(mockGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 120 });
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 121 * 1000,
      );
    });
  });

  describe('createPresignedGetUrl', () => {
    it('returns a signed URL using the default GET TTL', async () => {
      // Arrange
      mockGetSignedUrl.mockResolvedValue('https://signed.example.test/get');
      const before = Date.now();

      // Act
      const result = await service.createPresignedGetUrl('videos/abc.mp4');

      // Assert
      expect(result.url).toBe('https://signed.example.test/get');
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + DEFAULT_GET_URL_EXPIRY_SECONDS * 1000,
      );
      expect(mockGetSignedUrl.mock.calls[0][1]).toBeInstanceOf(
        GetObjectCommand,
      );
      const command = mockGetSignedUrl.mock.calls[0][1] as GetObjectCommand;
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'videos/abc.mp4',
      });
    });
  });

  describe('headObject / objectExists', () => {
    it('returns metadata for an object that exists', async () => {
      // Arrange
      const lastModified = new Date('2026-01-01T00:00:00.000Z');
      mockClient.send.mockResolvedValue({
        ContentLength: 1024,
        ContentType: 'video/mp4',
        LastModified: lastModified,
        ETag: '"abc123"',
      });

      // Act
      const metadata = await service.headObject('videos/abc.mp4');

      // Assert
      expect(metadata).toEqual({
        key: 'videos/abc.mp4',
        contentLength: 1024,
        contentType: 'video/mp4',
        lastModified,
        etag: '"abc123"',
      });
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(mockClient.send.mock.calls[0][0]).toBeInstanceOf(
        HeadObjectCommand,
      );
      const command = mockClient.send.mock.calls[0][0] as HeadObjectCommand;
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'videos/abc.mp4',
      });
    });

    it('returns null when the client rejects with a NotFound-named error', async () => {
      // Arrange
      const notFoundError = Object.assign(new Error('not found'), {
        name: 'NotFound',
      });
      mockClient.send.mockRejectedValue(notFoundError);

      // Act
      const metadata = await service.headObject('videos/missing.mp4');

      // Assert
      expect(metadata).toBeNull();
    });

    it('returns null when the client rejects with a 404 in $metadata', async () => {
      // Arrange
      const notFoundError = Object.assign(new Error('not found'), {
        $metadata: { httpStatusCode: 404 },
      });
      mockClient.send.mockRejectedValue(notFoundError);

      // Act
      const metadata = await service.headObject('videos/missing.mp4');

      // Assert
      expect(metadata).toBeNull();
    });

    it('rethrows any other error from the client', async () => {
      // Arrange
      const serverError = Object.assign(new Error('internal error'), {
        $metadata: { httpStatusCode: 500 },
      });
      mockClient.send.mockRejectedValue(serverError);

      // Act & Assert
      await expect(service.headObject('videos/abc.mp4')).rejects.toBe(
        serverError,
      );
    });

    it('objectExists resolves true when headObject finds metadata', async () => {
      // Arrange
      mockClient.send.mockResolvedValue({ ContentLength: 10 });

      // Act & Assert
      expect(await service.objectExists('videos/abc.mp4')).toBe(true);
    });

    it('objectExists resolves false when headObject returns null', async () => {
      // Arrange
      mockClient.send.mockRejectedValue(
        Object.assign(new Error('not found'), { name: 'NotFound' }),
      );

      // Act & Assert
      expect(await service.objectExists('videos/missing.mp4')).toBe(false);
    });
  });

  describe('deleteObject', () => {
    it('sends a DeleteObjectCommand for the configured bucket and key', async () => {
      // Arrange
      mockClient.send.mockResolvedValue({});

      // Act
      await service.deleteObject('videos/abc.mp4');

      // Assert
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      const command = mockClient.send.mock.calls[0][0] as DeleteObjectCommand;
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'videos/abc.mp4',
      });
    });
  });

  describe('putObject', () => {
    it('sends a PutObjectCommand with the body and content type for the configured bucket and key', async () => {
      // Arrange
      mockClient.send.mockResolvedValue({});
      const body = Buffer.from('fake-thumbnail-bytes');

      // Act
      await service.putObject('thumbnails/abc/w480.jpg', body, 'image/jpeg');

      // Assert
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      const command = mockClient.send.mock.calls[0][0] as PutObjectCommand;
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'thumbnails/abc/w480.jpg',
        Body: body,
        ContentType: 'image/jpeg',
      });
    });

    it('omits ContentType when not provided', async () => {
      // Arrange
      mockClient.send.mockResolvedValue({});
      const body = Buffer.from('fake-bytes');

      // Act
      await service.putObject('thumbnails/abc/w480.jpg', body);

      // Assert
      const command = mockClient.send.mock.calls[0][0] as PutObjectCommand;
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'thumbnails/abc/w480.jpg',
        Body: body,
        ContentType: undefined,
      });
    });
  });

  describe('downloadObjectToFile (Slice 11P)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'storage-service-spec-'));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('streams the mocked GetObject Body to the destination file', async () => {
      const destPath = join(tempDir, 'source.mp4');
      mockClient.send.mockResolvedValue({
        Body: Readable.from([Buffer.from('fake-video-bytes')]),
      });

      await service.downloadObjectToFile('admin-media/x/source', destPath);

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      const command = mockClient.send.mock.calls[0][0] as GetObjectCommand;
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Key: 'admin-media/x/source',
      });
      const written = await readFile(destPath);
      expect(written.toString()).toBe('fake-video-bytes');
    });

    it('throws (and writes nothing usable) when the response has no Body', async () => {
      const destPath = join(tempDir, 'source.mp4');
      mockClient.send.mockResolvedValue({});

      await expect(
        service.downloadObjectToFile('admin-media/x/source', destPath),
      ).rejects.toThrow(/no body/i);
    });

    it('propagates a stream error instead of silently leaving a partial file', async () => {
      const destPath = join(tempDir, 'source.mp4');
      const failingStream = new Readable({
        read() {
          this.destroy(new Error('simulated network interruption'));
        },
      });
      mockClient.send.mockResolvedValue({ Body: failingStream });

      await expect(
        service.downloadObjectToFile('admin-media/x/source', destPath),
      ).rejects.toThrow('simulated network interruption');
    });
  });

  describe('listObjectKeysByPrefix (Slice 11P)', () => {
    it('returns key + lastModified pairs for every entry in the mocked response', async () => {
      const lastModified = new Date('2026-01-01T00:00:00.000Z');
      mockClient.send.mockResolvedValue({
        Contents: [
          {
            Key: 'admin-media/x/hls/v1-a1-uuid/master.m3u8',
            LastModified: lastModified,
          },
          {
            Key: 'admin-media/x/hls/v1-a1-uuid/360p/index.m3u8',
            LastModified: lastModified,
          },
        ],
      });

      const result = await service.listObjectKeysByPrefix('admin-media/x/hls/');

      expect(result).toEqual([
        { key: 'admin-media/x/hls/v1-a1-uuid/master.m3u8', lastModified },
        {
          key: 'admin-media/x/hls/v1-a1-uuid/360p/index.m3u8',
          lastModified,
        },
      ]);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      const command = mockClient.send.mock.calls[0][0] as ListObjectsV2Command;
      expect(command).toBeInstanceOf(ListObjectsV2Command);
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Prefix: 'admin-media/x/hls/',
        MaxKeys: DEFAULT_LIST_MAX_KEYS,
      });
    });

    it('honors a caller-supplied maxKeys override', async () => {
      mockClient.send.mockResolvedValue({ Contents: [] });

      await service.listObjectKeysByPrefix('admin-media/x/hls/', 25);

      const command = mockClient.send.mock.calls[0][0] as ListObjectsV2Command;
      expect(command.input).toMatchObject({ MaxKeys: 25 });
    });

    it('returns an empty array when Contents is absent', async () => {
      mockClient.send.mockResolvedValue({});

      expect(
        await service.listObjectKeysByPrefix('admin-media/x/hls/'),
      ).toEqual([]);
    });

    it('filters out entries with no Key', async () => {
      mockClient.send.mockResolvedValue({
        Contents: [
          { LastModified: new Date() },
          { Key: 'admin-media/x/hls/v1/master.m3u8' },
        ],
      });

      const result = await service.listObjectKeysByPrefix('admin-media/x/hls/');

      expect(result).toEqual([
        { key: 'admin-media/x/hls/v1/master.m3u8', lastModified: undefined },
      ]);
    });

    it('never asks for a continuation token, so its single-page contract is unchanged', async () => {
      mockClient.send.mockResolvedValue({
        Contents: [{ Key: 'admin-media/x/hls/v1/master.m3u8' }],
        IsTruncated: true,
        NextContinuationToken: 'more-pages-exist',
      });

      // Even against a TRUNCATED response, this method still issues exactly
      // one request and simply returns that page's entries — the behavior
      // `TranscodeJanitorService` has always relied on.
      const result = await service.listObjectKeysByPrefix('admin-media/x/hls/');

      expect(result).toHaveLength(1);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      const command = mockClient.send.mock.calls[0][0] as ListObjectsV2Command;
      expect(command.input.ContinuationToken).toBeUndefined();
    });
  });

  describe('listObjectPageByPrefix (Series cover orphan cleanup slice)', () => {
    it('passes the caller-supplied continuation token straight through', async () => {
      mockClient.send.mockResolvedValue({ Contents: [] });

      await service.listObjectPageByPrefix('admin-series/', {
        maxKeys: 250,
        continuationToken: 'opaque-token',
      });

      const command = mockClient.send.mock.calls[0][0] as ListObjectsV2Command;
      expect(command).toBeInstanceOf(ListObjectsV2Command);
      expect(command.input).toEqual({
        Bucket: 'mock-bucket',
        Prefix: 'admin-series/',
        MaxKeys: 250,
        ContinuationToken: 'opaque-token',
      });
    });

    it('defaults MaxKeys and omits the token on a first page', async () => {
      mockClient.send.mockResolvedValue({ Contents: [] });

      await service.listObjectPageByPrefix('admin-series/');

      const command = mockClient.send.mock.calls[0][0] as ListObjectsV2Command;
      expect(command.input.MaxKeys).toBe(DEFAULT_LIST_MAX_KEYS);
      expect(command.input.ContinuationToken).toBeUndefined();
    });

    it('returns the next token when the response is truncated', async () => {
      const lastModified = new Date('2026-01-01T00:00:00.000Z');
      mockClient.send.mockResolvedValue({
        Contents: [
          { Key: 'admin-series/a/cover/uuid', LastModified: lastModified },
        ],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      });

      expect(await service.listObjectPageByPrefix('admin-series/')).toEqual({
        entries: [{ key: 'admin-series/a/cover/uuid', lastModified }],
        nextContinuationToken: 'page-2',
      });
    });

    it('returns NO token on the final page, which is what terminates a paging loop', async () => {
      mockClient.send.mockResolvedValue({
        Contents: [{ Key: 'admin-series/a/cover/uuid' }],
        IsTruncated: false,
        NextContinuationToken: 'stale-token-that-must-be-ignored',
      });

      const page = await service.listObjectPageByPrefix('admin-series/');

      expect(page.nextContinuationToken).toBeUndefined();
    });

    it.each([
      ['a truncated response carrying no token at all', { IsTruncated: true }],
      [
        'a truncated response carrying an empty token',
        { IsTruncated: true, NextContinuationToken: '' },
      ],
    ])(
      'returns no token for %s, so a paging loop terminates instead of repeating',
      async (_label, response) => {
        mockClient.send.mockResolvedValue({ Contents: [], ...response });

        const page = await service.listObjectPageByPrefix('admin-series/');

        expect(page.nextContinuationToken).toBeUndefined();
      },
    );

    it('returns an empty page when Contents is absent', async () => {
      mockClient.send.mockResolvedValue({});

      expect(await service.listObjectPageByPrefix('admin-series/')).toEqual({
        entries: [],
        nextContinuationToken: undefined,
      });
    });

    it('filters out entries with no Key', async () => {
      mockClient.send.mockResolvedValue({
        Contents: [
          { LastModified: new Date() },
          { Key: 'admin-series/a/cover/uuid' },
        ],
      });

      const page = await service.listObjectPageByPrefix('admin-series/');

      expect(page.entries).toEqual([
        { key: 'admin-series/a/cover/uuid', lastModified: undefined },
      ]);
    });
  });

  describe('buildPublicUrl', () => {
    it('joins the configured public base URL and key with exactly one slash', () => {
      expect(service.buildPublicUrl('videos/abc.mp4')).toBe(
        'https://media.example.test/videos/abc.mp4',
      );
    });

    it('tolerates a leading slash on the key', () => {
      expect(service.buildPublicUrl('/videos/abc.mp4')).toBe(
        'https://media.example.test/videos/abc.mp4',
      );
    });

    it('tolerates a trailing slash on the configured base URL', () => {
      const svc = new StorageService(
        buildFakeConfigService({
          publicBaseUrl: 'https://media.example.test/',
        }),
        mockClient as unknown as S3Client,
      );

      expect(svc.buildPublicUrl('videos/abc.mp4')).toBe(
        'https://media.example.test/videos/abc.mp4',
      );
    });

    /**
     * Phase 11, work unit 11H-B1 / 11H-T1: `OBJECT_STORAGE_PUBLIC_BASE_URL`
     * is now optional (`StorageConfig.publicBaseUrl` is `string | undefined`
     * — see `configuration.ts`). `buildPublicUrl` must throw a clear
     * configuration error naming the variable, never fabricate a bogus URL
     * from an empty/missing base. This has zero callers in production code
     * today (only this spec exercises it) — see `env.validation.ts`'s
     * `REQUIRED_R2_KEYS` doc comment for that grounding fact.
     *
     * Mutation-tested: temporarily changing `buildPublicUrl` to fall back to
     * `?? ''` and keep returning a string (i.e. reverting to pre-11H-B1
     * behavior) was manually verified to fail the "does not return a
     * string" assertion below, then reverted — see the 11H-T1 handoff notes
     * for that run's output.
     */
    describe('without a configured base URL (Phase 11, work unit 11H-B1)', () => {
      it('throws — and does not return a string — when publicBaseUrl is undefined', () => {
        const svc = new StorageService(
          buildFakeConfigService({ publicBaseUrl: undefined }),
          mockClient as unknown as S3Client,
        );

        let thrown: unknown;
        let returned: unknown;
        try {
          returned = svc.buildPublicUrl('videos/abc.mp4');
        } catch (error) {
          thrown = error;
        }

        expect(returned).toBeUndefined();
        expect(thrown).toBeInstanceOf(Error);
        expect(typeof thrown).not.toBe('string');
      });

      it('throws when publicBaseUrl is an empty string too (never assembles a path-shaped bogus URL)', () => {
        const svc = new StorageService(
          buildFakeConfigService({ publicBaseUrl: '' }),
          mockClient as unknown as S3Client,
        );

        expect(() => svc.buildPublicUrl('videos/abc.mp4')).toThrow();
      });

      it('names OBJECT_STORAGE_PUBLIC_BASE_URL in the thrown error message', () => {
        const svc = new StorageService(
          buildFakeConfigService({ publicBaseUrl: undefined }),
          mockClient as unknown as S3Client,
        );

        expect(() => svc.buildPublicUrl('videos/abc.mp4')).toThrow(
          /OBJECT_STORAGE_PUBLIC_BASE_URL/,
        );
      });

      it('never leaks other configured credential-shaped values in the thrown error message', () => {
        const SENTINEL = 'SENTINEL-11H-BUILDPUBLICURL-DO-NOT-LEAK-4d21f8';
        const svc = new StorageService(
          buildFakeConfigService({
            publicBaseUrl: undefined,
            accessKeyId: SENTINEL,
            secretAccessKey: SENTINEL,
            bucket: SENTINEL,
            endpoint: `https://${SENTINEL}.example.test`,
          }),
          mockClient as unknown as S3Client,
        );

        let message = '';
        try {
          svc.buildPublicUrl('videos/abc.mp4');
        } catch (error) {
          message = (error as Error).message;
        }

        expect(message).not.toContain(SENTINEL);
      });
    });
  });
});
