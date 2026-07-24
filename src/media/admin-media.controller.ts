import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminMediaService } from './admin-media.service';
import { CompleteMediaUploadDto } from './dto/complete-media-upload.dto';
import { CreateMediaAssetUploadDto } from './dto/create-media-asset-upload.dto';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto';
import {
  AdminMediaDto,
  CreateMediaUploadResponseDto,
  MediaAssetUploadResponseDto,
} from './media.types';

/**
 * Phase 11, work unit 11B-3: the admin-guarded media upload/publish API.
 * Every route requires both a valid access token (`JwtAuthGuard`) and the
 * `admin` role (`AdminGuard`, 11B-2) — `JwtAuthGuard` MUST be listed first
 * so `AdminGuard` can read `request.user`. `StorageService` (via
 * `AdminMediaService`) is mocked in every test that exercises this
 * controller; no route here ever makes a real R2/S3 call in this
 * credential-free slice.
 */
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/media')
export class AdminMediaController {
  constructor(private readonly adminMediaService: AdminMediaService) {}

  @Post()
  createUpload(
    @Body() body: CreateMediaUploadDto,
  ): Promise<CreateMediaUploadResponseDto> {
    return this.adminMediaService.createUpload(body);
  }

  @Get(':id')
  getById(@Param('id') id: string): Promise<AdminMediaDto> {
    return this.adminMediaService.findById(id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/complete-upload')
  completeUpload(
    @Param('id') id: string,
    @Body() body: CompleteMediaUploadDto,
  ): Promise<AdminMediaDto> {
    return this.adminMediaService.completeUpload(id, body);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/publish')
  publish(@Param('id') id: string): Promise<AdminMediaDto> {
    return this.adminMediaService.publish(id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/unpublish')
  unpublish(@Param('id') id: string): Promise<AdminMediaDto> {
    return this.adminMediaService.unpublish(id);
  }

  @Post(':id/cover')
  createCoverUpload(
    @Param('id') id: string,
    @Body() body: CreateMediaAssetUploadDto,
  ): Promise<MediaAssetUploadResponseDto> {
    return this.adminMediaService.createCoverUpload(id, body);
  }

  @Post(':id/thumbnail')
  createThumbnailUpload(
    @Param('id') id: string,
    @Body() body: CreateMediaAssetUploadDto,
  ): Promise<MediaAssetUploadResponseDto> {
    return this.adminMediaService.createThumbnailUpload(id, body);
  }
}
