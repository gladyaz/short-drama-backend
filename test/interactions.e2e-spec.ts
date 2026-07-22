import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type {
  LikeResponseDto,
  SaveResponseDto,
  UserInteractionDto,
} from './../src/interactions/interaction.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * e2e coverage for the Phase 9 (work unit 9-B2) Like/Save endpoints, hitting
 * the real HTTP layer (routing, `JwtAuthGuard`, `AppExceptionFilter`)
 * against the real dev SQLite database, using the app's own seeded video
 * catalog (`video-104-01`) and a self-cleaning dedicated test user.
 */
describe('Interactions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  let userId: string;
  let otherAccessToken: string;
  let otherUserId: string;

  const emailPrefix = 'interactions-e2e-spec+9b2';
  const seededVideoId = 'video-104-01';
  const uniqueEmail = (label: string): string =>
    `${emailPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new AppExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);

    const registerResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('main'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const body = registerResponse.body as AuthResponseDto;
    accessToken = body.accessToken;
    userId = body.user.id;

    const otherRegisterResponse = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uniqueEmail('other'), password: 'correct-horse-battery' })
      .expect(HttpStatus.CREATED);

    const otherBody = otherRegisterResponse.body as AuthResponseDto;
    otherAccessToken = otherBody.accessToken;
    otherUserId = otherBody.user.id;
  });

  afterAll(async () => {
    await prisma.userVideoInteraction.deleteMany({ where: { userId } });
    await prisma.userVideoInteraction.deleteMany({
      where: { userId: otherUserId },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: emailPrefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { contains: emailPrefix } },
    });
    await app.close();
  });

  describe('auth guard', () => {
    it('rejects every interactions endpoint without an Authorization header', async () => {
      const unauthorized = [
        () =>
          request(app.getHttpServer()).post(`/videos/${seededVideoId}/like`),
        () =>
          request(app.getHttpServer()).delete(`/videos/${seededVideoId}/like`),
        () =>
          request(app.getHttpServer()).post(`/videos/${seededVideoId}/save`),
        () =>
          request(app.getHttpServer()).delete(`/videos/${seededVideoId}/save`),
        () => request(app.getHttpServer()).get('/users/me/interactions'),
      ];

      for (const makeRequest of unauthorized) {
        const response = await makeRequest().expect(HttpStatus.UNAUTHORIZED);
        expect((response.body as ErrorResponseBody).code).toBe(
          'INVALID_ACCESS_TOKEN',
        );
      }
    });
  });

  describe('like/unlike', () => {
    it('likes a video, incrementing likeCount, then unlikes it back down', async () => {
      const before = await request(app.getHttpServer())
        .get(`/videos/${seededVideoId}`)
        .expect(HttpStatus.OK);
      const initialLikeCount = (before.body as { likeCount: number }).likeCount;

      const likeResponse = await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/like`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CREATED);

      const likeBody = likeResponse.body as LikeResponseDto;
      expect(likeBody).toEqual({
        videoId: seededVideoId,
        isLiked: true,
        likeCount: initialLikeCount + 1,
      });

      const unlikeResponse = await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/like`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const unlikeBody = unlikeResponse.body as LikeResponseDto;
      expect(unlikeBody).toEqual({
        videoId: seededVideoId,
        isLiked: false,
        likeCount: initialLikeCount,
      });
    });

    it('rejects like with a structured 404 for a nonexistent videoId', async () => {
      const response = await request(app.getHttpServer())
        .post('/videos/does-not-exist/like')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body).toEqual({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'VIDEO_NOT_FOUND',
        message: 'Video not found',
      });
    });
  });

  describe('save/unsave', () => {
    it('saves and unsaves a video', async () => {
      const saveResponse = await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CREATED);

      expect(saveResponse.body as SaveResponseDto).toEqual({
        videoId: seededVideoId,
        isSaved: true,
      });

      const unsaveResponse = await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      expect(unsaveResponse.body as SaveResponseDto).toEqual({
        videoId: seededVideoId,
        isSaved: false,
      });
    });

    it('rejects save with a structured 404 for a nonexistent videoId', async () => {
      const response = await request(app.getHttpServer())
        .post('/videos/does-not-exist/save')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body).toEqual({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'VIDEO_NOT_FOUND',
        message: 'Video not found',
      });
    });
  });

  describe('GET /users/me/interactions', () => {
    it('returns the like/save state for the authenticated user only', async () => {
      await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/like`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .get('/users/me/interactions')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);

      const rows = response.body as UserInteractionDto[];
      expect(rows).toContainEqual({
        videoId: seededVideoId,
        isLiked: true,
        isSaved: true,
      });

      await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/like`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
      await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
    });

    it('keeps two users like/save state on the same shared video independent', async () => {
      // The main user likes-and-saves the seeded video; the other user only
      // saves it. Each user's own GET /users/me/interactions view must
      // reflect exactly their own isLiked/isSaved state for that same
      // video, not the other user's.
      await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/like`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CREATED);
      await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.CREATED);

      await request(app.getHttpServer())
        .post(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.CREATED);

      const mainResponse = await request(app.getHttpServer())
        .get('/users/me/interactions')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
      const otherResponse = await request(app.getHttpServer())
        .get('/users/me/interactions')
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.OK);

      expect(mainResponse.body as UserInteractionDto[]).toContainEqual({
        videoId: seededVideoId,
        isLiked: true,
        isSaved: true,
      });
      expect(otherResponse.body as UserInteractionDto[]).toContainEqual({
        videoId: seededVideoId,
        isLiked: false,
        isSaved: true,
      });

      await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/like`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
      await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK);
      await request(app.getHttpServer())
        .delete(`/videos/${seededVideoId}/save`)
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(HttpStatus.OK);
    });
  });
});
