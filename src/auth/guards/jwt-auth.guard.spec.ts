import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AppException } from '../../common/errors/app.exception';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { JwtAuthGuard, RequestWithUser } from './jwt-auth.guard';

const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
};

/**
 * Builds a minimal fake `ExecutionContext` wrapping a fake HTTP request, just
 * enough surface for `JwtAuthGuard.canActivate` to read the `Authorization`
 * header and attach `request.user`.
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

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        JwtAuthGuard,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(TEST_AUTH_CONFIG) },
        },
      ],
    }).compile();

    guard = module.get<JwtAuthGuard>(JwtAuthGuard);
    jwtService = module.get<JwtService>(JwtService);
  });

  async function signValidToken(
    payload: Record<string, unknown> = { sub: 'user-123' },
    expiresIn = '15m',
  ): Promise<string> {
    return jwtService.signAsync(payload, {
      secret: TEST_AUTH_CONFIG.jwtAccessSecret,
      expiresIn,
    });
  }

  it('allows the request and attaches the user when the token is valid', async () => {
    const token = await signValidToken({ sub: 'user-123' });
    const { context, request } = buildContext({
      authorization: `Bearer ${token}`,
    });

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(request.user).toEqual({ id: 'user-123' });
  });

  it('rejects when the Authorization header is missing', async () => {
    const { context } = buildContext({});

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('rejects when the Authorization header is malformed (not "Bearer <token>")', async () => {
    const { context } = buildContext({ authorization: 'Token abc.def.ghi' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
    });
  });

  it('rejects when the Authorization header is "Bearer" with no token', async () => {
    const { context } = buildContext({ authorization: 'Bearer ' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
    });
  });

  it('rejects an expired token', async () => {
    const token = await signValidToken({ sub: 'user-123' }, '0s');
    // Ensure the token has actually crossed its expiry boundary.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { context } = buildContext({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
    });
  }, 10000);

  it('rejects a token with a tampered/invalid signature', async () => {
    const token = await signValidToken({ sub: 'user-123' });
    const tampered = `${token.slice(0, -1)}${token.slice(-1) === 'a' ? 'b' : 'a'}`;

    const { context } = buildContext({ authorization: `Bearer ${tampered}` });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await jwtService.signAsync(
      { sub: 'user-123' },
      { secret: 'a-completely-different-secret', expiresIn: '15m' },
    );

    const { context } = buildContext({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: AppErrorCode.INVALID_ACCESS_TOKEN,
    });
  });
});
