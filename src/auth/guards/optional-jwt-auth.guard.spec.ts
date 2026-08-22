import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AppException } from '../../common/errors/app.exception';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { RequestWithUser } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
};

/**
 * Mirrors `jwt-auth.guard.spec.ts`'s own `buildContext` exactly — the two
 * guards read the request the same way, so the harness that proves it must
 * be the same shape.
 */
function buildContext(headers: Record<string, string>): {
  context: ExecutionContext;
  request: RequestWithUser;
} {
  const request = { headers } as unknown as RequestWithUser;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

/**
 * Work unit "ANONYMOUS FREE-EPISODE PLAYBACK". This file is the primary
 * anti-bypass proof for optional auth: the whole feature is only safe if
 * "no credential was supplied" and "a credential was supplied and is bad"
 * stay strictly separate outcomes. Every `rejects` assertion below is a
 * case that MUST NOT become an anonymous request.
 */
describe('OptionalJwtAuthGuard', () => {
  let guard: OptionalJwtAuthGuard;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        OptionalJwtAuthGuard,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(TEST_AUTH_CONFIG) },
        },
      ],
    }).compile();

    guard = module.get<OptionalJwtAuthGuard>(OptionalJwtAuthGuard);
    jwtService = module.get<JwtService>(JwtService);
  });

  async function signValidToken(
    payload: Record<string, unknown> = { sub: 'user-123' },
    expiresIn: string | number = '15m',
  ): Promise<string> {
    return jwtService.signAsync(payload, {
      secret: TEST_AUTH_CONFIG.jwtAccessSecret,
      expiresIn,
    });
  }

  describe('anonymous (no credential supplied) — the ONLY tolerated no-user case', () => {
    it('allows the request and leaves request.user undefined when there is no Authorization header at all', async () => {
      const { context, request } = buildContext({});

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('allows the request when the Authorization header is present but empty (no credential to be invalid)', async () => {
      const { context, request } = buildContext({ authorization: '' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('allows the request when the Authorization header is whitespace only', async () => {
      const { context, request } = buildContext({ authorization: '   ' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });
  });

  describe('authenticated (valid credential supplied)', () => {
    it('attaches the user exactly as JwtAuthGuard would when the token is valid', async () => {
      const token = await signValidToken({ sub: 'user-123' });
      const { context, request } = buildContext({
        authorization: `Bearer ${token}`,
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toEqual({ id: 'user-123' });
    });
  });

  describe('CRITICAL — a supplied but unusable credential must NEVER fall back to guest', () => {
    it('rejects an expired token instead of treating it as anonymous', async () => {
      const token = await signValidToken({ sub: 'user-123' }, '0s');
      // Ensure the token has actually crossed its expiry boundary.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const { context, request } = buildContext({
        authorization: `Bearer ${token}`,
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
      expect(request.user).toBeUndefined();
    }, 10000);

    it('rejects a token with a tampered/invalid signature', async () => {
      const token = await signValidToken({ sub: 'user-123' });
      const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`;

      const { context } = buildContext({ authorization: `Bearer ${tampered}` });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
    });

    it('rejects a token signed with the WRONG secret (e.g. the refresh secret)', async () => {
      const token = await jwtService.signAsync(
        { sub: 'user-123' },
        { secret: TEST_AUTH_CONFIG.jwtRefreshSecret, expiresIn: '15m' },
      );

      const { context } = buildContext({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
    });

    it('rejects a structurally malformed token', async () => {
      const { context } = buildContext({
        authorization: 'Bearer not-a-jwt-at-all',
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        AppException,
      );
    });

    it('rejects a non-Bearer scheme rather than ignoring it', async () => {
      const { context } = buildContext({ authorization: 'Token abc.def.ghi' });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
    });

    it('rejects Basic auth credentials rather than ignoring them', async () => {
      const { context } = buildContext({
        authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`,
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
    });

    it('rejects "Bearer " with no token after it', async () => {
      const { context } = buildContext({ authorization: 'Bearer ' });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
    });

    it('rejects a bare "Bearer" with no trailing space', async () => {
      const { context } = buildContext({ authorization: 'Bearer' });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
    });

    it('rejects a validly-signed token whose payload carries no sub', async () => {
      const token = await signValidToken({ role: 'admin' });

      const { context, request } = buildContext({
        authorization: `Bearer ${token}`,
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
      });
      expect(request.user).toBeUndefined();
    });

    it('rejects with the same generic AppException JwtAuthGuard uses — no new/leakier error contract', async () => {
      const { context } = buildContext({ authorization: 'Bearer garbage' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        AppException,
      );
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: AppErrorCode.INVALID_ACCESS_TOKEN,
        message: 'Invalid or expired access token',
      });
    });
  });
});
