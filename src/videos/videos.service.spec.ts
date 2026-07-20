import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { VideosService } from './videos.service';

jest.mock('fs');

const TEST_APP_CONFIG = {
  port: 3000,
  publicBaseUrl: 'http://localhost:3000',
  storageRoot: '/company/storage',
  corsOrigins: ['http://localhost:8081'],
};

describe('VideosService', () => {
  let service: VideosService;
  const mockedFs = fs as jest.Mocked<typeof fs>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(TEST_APP_CONFIG) },
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  describe('findAll', () => {
    it('returns at least three videos with generated playbackUrl and no absolute storage path', () => {
      const videos = service.findAll();

      expect(videos.length).toBeGreaterThanOrEqual(3);

      const serialized = JSON.stringify(videos);
      expect(serialized).not.toContain(TEST_APP_CONFIG.storageRoot);

      for (const video of videos) {
        expect(video.playbackUrl).toBe(
          `http://localhost:3000/videos/${video.id}/stream`,
        );
        expect(video.storageKey.startsWith('/')).toBe(false);
        expect(video.hasEmbeddedIndonesianSubtitle).toBe(true);
      }
    });
  });

  describe('findById', () => {
    it('returns the matching video for a known id', () => {
      expect(service.findById('video-104-01').id).toBe('video-104-01');
    });

    it('throws VIDEO_NOT_FOUND for an unknown id', () => {
      let caught: unknown;
      try {
        service.findById('does-not-exist');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(AppErrorCode.VIDEO_NOT_FOUND);
    });
  });

  describe('resolveStreamableFile', () => {
    it('returns the absolute path and size when the media file exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({
        isFile: () => true,
        size: 4096,
      } as unknown as fs.Stats);

      const result = service.resolveStreamableFile('video-104-01');

      expect(result.fileSize).toBe(4096);
      expect(result.absolutePath.startsWith(TEST_APP_CONFIG.storageRoot)).toBe(
        true,
      );
    });

    it('throws MEDIA_FILE_NOT_FOUND when the file is missing on disk', () => {
      mockedFs.existsSync.mockReturnValue(false);

      let caught: unknown;
      try {
        service.resolveStreamableFile('video-104-01');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).code).toBe(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
      );
    });

    it('throws VIDEO_NOT_FOUND for an unknown id without touching the filesystem', () => {
      expect(() => service.resolveStreamableFile('does-not-exist')).toThrow(
        AppException,
      );
      expect(mockedFs.existsSync).not.toHaveBeenCalled();
    });
  });
});
