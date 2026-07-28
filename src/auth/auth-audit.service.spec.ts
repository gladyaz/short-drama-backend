import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthAuditService } from './auth-audit.service';
import { MAX_USER_AGENT_LENGTH } from './auth-audit.types';

const TEST_SECRET = 'test-auth-audit-ip-hash-secret-not-a-real-secret';
const OTHER_SECRET = 'a-completely-different-test-secret-not-a-real-secret';

function configServiceStub(authAuditIpHashSecret: string): ConfigService {
  return {
    get: jest.fn().mockReturnValue({ authAuditIpHashSecret }),
  } as unknown as ConfigService;
}

/**
 * Phase 12, work unit 12A-B3 (DECISIONS.md "Phase 12 ... approved..." entry,
 * decision 6). Integration-style spec, following the same pattern as
 * `account-lockout.service.spec.ts`: real `PrismaService` against the
 * project's dev database, self-cleaning via `afterEach`.
 *
 * These tests cover `AuthAuditService.emit` itself in isolation. See
 * `auth.service.spec.ts` (search "Phase 12, work unit 12A-B3") for coverage
 * proving `AuthService`'s real login/register/refresh call sites actually
 * invoke this service.
 */
describe('AuthAuditService', () => {
  let service: AuthAuditService;
  let prisma: PrismaService;

  const marker = 'auth-audit-service-spec+12a-b3';
  const uniqueUserAgent = (label: string): string =>
    `${marker}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthAuditService,
        PrismaService,
        { provide: ConfigService, useValue: configServiceStub(TEST_SECRET) },
      ],
    }).compile();

    service = module.get<AuthAuditService>(AuthAuditService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.authAuditEvent.deleteMany({
      where: { userAgent: { contains: marker } },
    });
    await prisma.onModuleDestroy();
  });

  describe('IP hashing', () => {
    it('never stores the raw IP — the persisted ipHash differs from the input IP', async () => {
      const rawIp = '203.0.113.55';
      const userAgent = uniqueUserAgent('ip-not-raw');

      await service.emit('login_success', { ip: rawIp, userAgent });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent },
      });
      expect(row).not.toBeNull();
      expect(row!.ipHash).not.toBeNull();
      expect(row!.ipHash).not.toBe(rawIp);
      // A real HMAC-SHA256 hex digest is 64 characters.
      expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hashes the SAME IP to the SAME value (deterministic, for correlation across events)', async () => {
      const rawIp = '203.0.113.77';
      const firstUserAgent = uniqueUserAgent('ip-deterministic-1');
      const secondUserAgent = uniqueUserAgent('ip-deterministic-2');

      await service.emit('login_success', {
        ip: rawIp,
        userAgent: firstUserAgent,
      });
      await service.emit('login_failed', {
        ip: rawIp,
        userAgent: secondUserAgent,
        metadata: { reason: 'invalid_password' },
      });

      const [first, second] = await Promise.all([
        prisma.authAuditEvent.findFirst({
          where: { userAgent: firstUserAgent },
        }),
        prisma.authAuditEvent.findFirst({
          where: { userAgent: secondUserAgent },
        }),
      ]);

      expect(first!.ipHash).toBe(second!.ipHash);
    });

    it('hashes the SAME IP to a DIFFERENT value under a different secret (keyed HMAC, not plain hash)', async () => {
      const rawIp = '203.0.113.88';

      const otherModule: TestingModule = await Test.createTestingModule({
        providers: [
          AuthAuditService,
          PrismaService,
          {
            provide: ConfigService,
            useValue: configServiceStub(OTHER_SECRET),
          },
        ],
      }).compile();
      const otherService = otherModule.get<AuthAuditService>(AuthAuditService);
      const otherPrisma = otherModule.get<PrismaService>(PrismaService);
      await otherPrisma.onModuleInit();

      const firstUserAgent = uniqueUserAgent('ip-secret-a');
      const secondUserAgent = uniqueUserAgent('ip-secret-b');

      try {
        await service.emit('login_success', {
          ip: rawIp,
          userAgent: firstUserAgent,
        });
        await otherService.emit('login_success', {
          ip: rawIp,
          userAgent: secondUserAgent,
        });

        const [withDefaultSecret, withOtherSecret] = await Promise.all([
          prisma.authAuditEvent.findFirst({
            where: { userAgent: firstUserAgent },
          }),
          prisma.authAuditEvent.findFirst({
            where: { userAgent: secondUserAgent },
          }),
        ]);

        expect(withDefaultSecret!.ipHash).not.toBe(withOtherSecret!.ipHash);
      } finally {
        await otherPrisma.authAuditEvent.deleteMany({
          where: { userAgent: { contains: marker } },
        });
        await otherPrisma.onModuleDestroy();
      }
    });

    it('stores a null ipHash when no IP is supplied', async () => {
      const userAgent = uniqueUserAgent('ip-absent');

      await service.emit('login_success', { userAgent });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent },
      });
      expect(row!.ipHash).toBeNull();
    });
  });

  describe('user-agent sanitization', () => {
    it('truncates a user agent longer than the max length', async () => {
      const overlongUserAgent = `${marker}-${'x'.repeat(MAX_USER_AGENT_LENGTH + 50)}`;

      await service.emit('login_success', { userAgent: overlongUserAgent });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent: { startsWith: marker } },
      });
      expect(row!.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
      expect(row!.userAgent).toBe(
        overlongUserAgent.slice(0, MAX_USER_AGENT_LENGTH),
      );
    });

    it('strips control characters from the user agent before storage', async () => {
      const marked = uniqueUserAgent('control-chars');
      // Constructed via `String.fromCharCode` (not a literal escape in the
      // source) to avoid any ambiguity about embedding raw control bytes
      // directly in a template literal: char code 10 is `\n` (LF), char
      // code 127 is DEL -- both ASCII control characters that must be
      // stripped entirely (not replaced with a space).
      const withControlChars = `${marked}${String.fromCharCode(10)}trai${String.fromCharCode(127)}ler`;

      await service.emit('login_success', { userAgent: withControlChars });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent: { startsWith: marked } },
      });
      expect(row!.userAgent).toBe(`${marked}trailer`);
    });
  });

  describe('metadata allowlisting', () => {
    it('drops metadata keys that are not on the allowlist for the event, keeping only allowlisted ones', async () => {
      const userAgent = uniqueUserAgent('metadata-allowlist');

      await service.emit('login_failed', {
        userAgent,
        metadata: {
          reason: 'invalid_password',
          password: 'super-secret-should-never-be-stored',
          token: 'refresh-token-should-never-be-stored',
          email: 'should-not-be-stored@example.test',
          extraneous: 'not-on-the-allowlist',
        },
      });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent },
      });
      expect(row!.metadata).toEqual({ reason: 'invalid_password' });
      const serialized = JSON.stringify(row!.metadata);
      expect(serialized).not.toContain('super-secret-should-never-be-stored');
      expect(serialized).not.toContain('refresh-token-should-never-be-stored');
      expect(serialized).not.toContain('example.test');
      expect(serialized).not.toContain('extraneous');
    });

    it('stores null metadata for an event with no allowlisted keys / no metadata supplied', async () => {
      const userAgent = uniqueUserAgent('metadata-empty');

      await service.emit('login_success', { userAgent });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent },
      });
      expect(row!.metadata).toBeNull();
    });

    it('drops a non-scalar (object/array) value even for an allowlisted key', async () => {
      const userAgent = uniqueUserAgent('metadata-non-scalar');

      await service.emit('login_failed', {
        userAgent,
        metadata: { reason: { nested: 'object-should-be-dropped' } },
      });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent },
      });
      expect(row!.metadata).toBeNull();
    });
  });

  describe('userId', () => {
    it('stores a null userId when none is supplied', async () => {
      const userAgent = uniqueUserAgent('userid-absent');

      await service.emit('login_success', { userAgent });

      const row = await prisma.authAuditEvent.findFirst({
        where: { userAgent },
      });
      expect(row!.userId).toBeNull();
    });
  });

  describe('failure handling', () => {
    it('does not throw/reject when the underlying database write fails', async () => {
      const createSpy = jest
        .spyOn(prisma.authAuditEvent, 'create')
        .mockRejectedValueOnce(new Error('simulated DB failure'));

      await expect(
        service.emit('login_success', {
          userAgent: uniqueUserAgent('db-failure'),
        }),
      ).resolves.toBeUndefined();

      createSpy.mockRestore();
    });
  });
});
