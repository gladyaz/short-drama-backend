import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import { createReadStream } from 'fs';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import {
  SERIES_COVER_RATE_LIMIT,
  SERIES_COVER_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { PublicSeriesService } from './series-public.service';
import { SERIES_COVER_CACHE_CONTROL } from './series-cover.constants';
import {
  SeriesDetailPublicDto,
  SeriesListResponseDto,
} from './series-public.types';

/**
 * Work unit "SERIES METADATA + DISCOVER ARTWORK CONTRACT": the public
 * catalog surface for curated series metadata — `GET /series` and
 * `GET /series/:id`. Deliberately a SEPARATE controller from
 * `SeriesController` (`./series.controller.ts`, `@Controller('admin/series')`,
 * `@UseGuards(JwtAuthGuard, AdminGuard)` at the class level): a guard
 * decorator on a controller class applies to every route declared on it,
 * so a public, unauthenticated route can never live on that class without
 * either an easy-to-miss per-route guard override or accidentally
 * inheriting the admin gate. No `@UseGuards` here at all, matching
 * `VideosController`'s existing `GET /videos/feed`/`GET /videos/:id`
 * precedent (public, unauthenticated metadata reads — only the
 * byte-streaming/playback-URL routes on that controller require a token).
 *
 * Work unit "LOCAL SERIES COVER ARTWORK": `GET /series/:id/cover` joins them.
 * It is public for the same reason the two metadata routes are — a series
 * cover is catalog artwork a signed-out visitor is meant to see, and the app
 * requests it as an `<Image>` source, which cannot carry an `Authorization`
 * header even if the user has one. It exposes nothing the already-public
 * `GET /series` does not: that route hands out the very URL this one serves.
 */
@Controller('series')
export class SeriesPublicController {
  constructor(private readonly publicSeriesService: PublicSeriesService) {}

  @Get()
  list(): Promise<SeriesListResponseDto> {
    return this.publicSeriesService.list();
  }

  /**
   * Streams one series's cover image off the local object store.
   *
   * ROUTE ORDER IS NOT LOAD-BEARING HERE, unlike `AdminMediaController`'s
   * `@Get()`/`@Get(':id')` pair. `:id` matches exactly one path segment, so
   * `/series/series-104/cover` cannot be captured by the `@Get(':id')` route
   * below whichever is declared first — this method is placed above it for
   * readability, not to win a match.
   *
   * ALL FAILURES ARE 404, deliberately and uniformly — see
   * `PublicSeriesService.resolveLocalCoverFile` for the five distinct
   * conditions collapsed into it. `SERIES_NOT_FOUND` is reused rather than a
   * new "cover not found" code being minted: from a caller's side there is
   * one truthful statement to make ("there is no cover to serve at this
   * URL"), and a finer-grained code would tell an unauthenticated prober
   * which of the five it hit.
   */
  @Throttle({
    default: {
      limit: SERIES_COVER_RATE_LIMIT,
      ttl: SERIES_COVER_RATE_TTL_MS,
    },
  })
  @Get(':id/cover')
  async getCover(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const cover = await this.publicSeriesService.resolveLocalCoverFile(id);

    if (cover === null) {
      throw new AppException(
        AppErrorCode.SERIES_NOT_FOUND,
        'Series cover not found',
        HttpStatus.NOT_FOUND,
      );
    }

    res.status(HttpStatus.OK);
    // Derived from the file's own leading bytes, never from its name or a
    // client-supplied value — so `helmet()`'s global
    // `X-Content-Type-Options: nosniff` is a guarantee here, not a hope.
    res.setHeader('Content-Type', cover.contentType);
    res.setHeader('Content-Length', cover.fileSize);
    res.setHeader('Cache-Control', SERIES_COVER_CACHE_CONTROL);
    // The ONE header this route overrides from `helmet()`'s defaults, scoped
    // to this handler alone — exactly as `VideosController#streamVideo` does,
    // for exactly the same reason. An `<img>`/`expo-image` element on a page
    // served from another origin (Expo Web on `http://localhost:8081`) issues
    // a NO-CORS request; `Cross-Origin-Resource-Policy: same-origin` makes
    // the browser discard the response before the element sees it, so the
    // request succeeds with 200 on the wire and the poster still never
    // appears, with no CORS error to explain it. `Access-Control-Allow-Origin`
    // does not help: CORP is a separate, stricter check.
    //
    // SAFE IN PRODUCTION TOO, and doubly so here. CORP defends a resource
    // privileged by AMBIENT AUTHORITY — a cookie the browser attaches by
    // itself. This API has none (no `res.cookie`, no cookie parser, no
    // `credentials: true` anywhere in `src/`; the only credential it reads is
    // the `Authorization` header). This route additionally requires no
    // credential at all and serves only bytes `GET /series` already publishes
    // a URL for, so relaxing CORP exposes nothing an anonymous `curl` could
    // not already fetch. The global `helmet()` call and every other route
    // keep `same-origin` untouched.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const stream = createReadStream(cover.absolutePath);
    // Mirrors `streamVideo`: a client that disconnects mid-response must not
    // leave the descriptor open.
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  @Get(':id')
  findById(@Param('id') id: string): Promise<SeriesDetailPublicDto> {
    return this.publicSeriesService.findById(id);
  }
}
