import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync } from 'fs';
import { AppConfig, RootConfig } from '../config/configuration';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { VIDEOS } from './videos.data';
import { VideoRecord, VideoResponseDto } from './video.types';
import { resolveSafeStoragePath } from './storage-path.util';

export interface StreamableVideo {
  record: VideoRecord;
  absolutePath: string;
  fileSize: number;
}

@Injectable()
export class VideosService {
  private readonly appConfig: AppConfig;

  constructor(private readonly configService: ConfigService<RootConfig>) {
    this.appConfig = this.configService.get('app', { infer: true })!;
  }

  findAll(): VideoResponseDto[] {
    return VIDEOS.map((record) => this.toResponseDto(record));
  }

  findById(id: string): VideoResponseDto {
    return this.toResponseDto(this.findRecordById(id));
  }

  resolveStreamableFile(id: string): StreamableVideo {
    const record = this.findRecordById(id);
    const absolutePath = resolveSafeStoragePath(
      this.appConfig.storageRoot,
      record.storageKey,
    );

    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new AppException(
        AppErrorCode.MEDIA_FILE_NOT_FOUND,
        'Media file not found on storage',
        HttpStatus.NOT_FOUND,
      );
    }

    const { size: fileSize } = statSync(absolutePath);
    return { record, absolutePath, fileSize };
  }

  private findRecordById(id: string): VideoRecord {
    const record = VIDEOS.find((video) => video.id === id);
    if (!record) {
      throw new AppException(
        AppErrorCode.VIDEO_NOT_FOUND,
        'Video not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return record;
  }

  private toResponseDto(record: VideoRecord): VideoResponseDto {
    return {
      id: record.id,
      seriesId: record.seriesId,
      title: record.title,
      episodeNumber: record.episodeNumber,
      channelName: record.channelName,
      caption: record.caption,
      category: record.category,
      storageKey: record.storageKey,
      playbackUrl: `${this.appConfig.publicBaseUrl}/videos/${record.id}/stream`,
      sourceLanguage: record.sourceLanguage,
      hasEmbeddedIndonesianSubtitle: record.hasEmbeddedIndonesianSubtitle,
      likeCount: record.likeCount,
      durationSeconds: record.durationSeconds,
      width: record.width,
      height: record.height,
    };
  }
}
