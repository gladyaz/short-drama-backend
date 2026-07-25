import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminMediaService } from './admin-media.service';
import { CompleteMediaUploadDto } from './dto/complete-media-upload.dto';
import { CreateMediaAssetUploadDto } from './dto/create-media-asset-upload.dto';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto';
import { ListAdminMediaQueryDto } from './dto/list-admin-media-query.dto';
import { UpdateAccessTierDto } from './dto/update-access-tier.dto';
import { UpdateMediaMetadataDto } from './dto/update-media-metadata.dto';
import {
  AdminMediaDto,
  AdminMediaListResponseDto,
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

  /**
   * Work unit 11E-1: the admin inventory list. Declared as a bare `@Get()`
   * (matches only the exact `/admin/media` collection path) ABOVE the
   * `@Get(':id')` item route below — Nest/Express route matching is
   * path-shape based, not declaration-order based, for these two (a
   * one-segment `:id` path never matches the zero-extra-segment collection
   * path or vice versa), but keeping the collection route first mirrors the
   * REST convention of listing the collection before a single item.
   */
  @Get()
  list(
    @Query() query: ListAdminMediaQueryDto,
  ): Promise<AdminMediaListResponseDto> {
    return this.adminMediaService.list(query);
  }

  @Get(':id')
  getById(@Param('id') id: string): Promise<AdminMediaDto> {
    return this.adminMediaService.findById(id);
  }

  /**
   * Work unit 11E-2: a partial metadata edit. Body validation (per-field
   * constraints, "at least one field", the global whitelist rejecting
   * unknown/immutable fields) all happen before `AdminMediaService` is ever
   * called — see `UpdateMediaMetadataDto` and
   * `AdminMediaService.updateMetadata`.
   */
  @Patch(':id')
  updateMetadata(
    @Param('id') id: string,
    @Body() body: UpdateMediaMetadataDto,
  ): Promise<AdminMediaDto> {
    return this.adminMediaService.updateMetadata(id, body);
  }

  /**
   * Work unit 11E-3: sets or clears the per-episode `accessTierOverride`
   * (`tier: "free" | "premium" | null`). A distinct, more specific route
   * than `PATCH /admin/media/:id` above (Nest/Express route matching is
   * path-shape based: `:id/access-tier` never collides with the bare `:id`
   * route), kept separate deliberately — the two-segment path shape mirrors
   * the existing `:id/complete-upload`, `:id/publish`, `:id/unpublish`
   * lifecycle-transition routes rather than folding a monetization-sensitive
   * field into the general metadata-edit body.
   */
  @Patch(':id/access-tier')
  updateAccessTier(
    @Param('id') id: string,
    @Body() body: UpdateAccessTierDto,
  ): Promise<AdminMediaDto> {
    return this.adminMediaService.updateAccessTier(id, body);
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
