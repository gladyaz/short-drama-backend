import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { RootConfig } from '../config/configuration';
import {
  DEFAULT_GET_URL_EXPIRY_SECONDS,
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

function buildFakeConfigService(): ConfigService<RootConfig> {
  return {
    get: () => TEST_STORAGE_CONFIG,
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
  });
});
