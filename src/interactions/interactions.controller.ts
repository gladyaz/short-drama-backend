import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InteractionsService } from './interactions.service';
import {
  LikeResponseDto,
  SaveResponseDto,
  UserInteractionDto,
} from './interaction.types';

/**
 * Phase 9, work unit 9-B2. Routes span two unrelated base paths
 * (`/videos/:id/like|save` and `/users/me/interactions`) per the frozen
 * contract, so this controller intentionally has no shared `@Controller()`
 * prefix — each handler declares its full path.
 */
@Controller()
export class InteractionsController {
  constructor(private readonly interactionsService: InteractionsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('videos/:id/like')
  like(
    @Param('id') videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LikeResponseDto> {
    return this.interactionsService.like(user.id, videoId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('videos/:id/like')
  @HttpCode(HttpStatus.OK)
  unlike(
    @Param('id') videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LikeResponseDto> {
    return this.interactionsService.unlike(user.id, videoId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('videos/:id/save')
  save(
    @Param('id') videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SaveResponseDto> {
    return this.interactionsService.save(user.id, videoId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('videos/:id/save')
  @HttpCode(HttpStatus.OK)
  unsave(
    @Param('id') videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SaveResponseDto> {
    return this.interactionsService.unsave(user.id, videoId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('users/me/interactions')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserInteractionDto[]> {
    return this.interactionsService.listForUser(user.id);
  }
}
