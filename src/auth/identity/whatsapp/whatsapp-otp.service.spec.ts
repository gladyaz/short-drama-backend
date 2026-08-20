import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  TEST_FIXTURE_PHONE_PREFIX,
  fixturePhone,
} from '../../../common/testing/fixture-namespace.helpers';
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from '../auth-identity.constants';
import {
  OtpRejected,
  OtpRequestThrottled,
  WhatsAppOtpService,
} from './whatsapp-otp.service';
import type {
  SendWhatsAppOtpInput,
  WhatsAppOtpProvider,
} from './whatsapp-otp.types';
import { WHATSAPP_OTP_PROVIDER } from './whatsapp-otp.types';

/**
 * PHASE 10B, fix cycle 1 — a unit spec for the OTP challenge lifecycle
 * itself, added in response to Reviewer B's finding 1 (which noted, fairly,
 * that `WhatsAppOtpService` had no spec of its own: it was only exercised
 * indirectly through `AuthIdentityService`).
 *
 * THE CENTRAL TEST HERE IS A POSITIVE CONTROL, following the precedent
 * `auth-lock-order.spec.ts` sets for this repository: it replays the
 * PRE-FIX statement sequence at the raw-database level and asserts the bad
 * outcome still occurs. Without it, the post-fix assertions below could pass
 * vacuously — and in fact they would have: the underlying commit-visibility
 * race does not reproduce reliably from ordinary concurrent calls on this
 * development hardware (measured: 8 simultaneous inserts, exactly one
 * believed itself the admission winner), so a test that merely fires a burst
 * proves nothing about the interleaving that matters.
 */
const TEST_AUTH_CONFIG = {
  jwtAccessSecret: 'test-access-secret-not-a-real-secret',
  jwtRefreshSecret: 'test-refresh-secret-not-a-real-secret',
  authAuditIpHashSecret: 'test-auth-audit-ip-hash-secret-not-a-real-secret',
};

class RecordingOtpProvider implements WhatsAppOtpProvider {
  readonly sent: SendWhatsAppOtpInput[] = [];

  sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  lastCodeFor(phoneE164: string): string {
    const match = [...this.sent]
      .reverse()
      .find((entry) => entry.phoneE164 === phoneE164);
    if (!match) {
      throw new Error(`No OTP was sent to ${phoneE164}`);
    }
    return match.code;
  }
}

/**
 * Typed access to the one private member these tests reach directly:
 * `hashOtpCode`, so the phone binding can be asserted without inferring it
 * from two full round trips. Declared as a real type rather than an inline
 * `as unknown as {...}` cast — a bare cast returns `any`, which both defeats
 * the type checker and trips this project's `no-unsafe-call` lint rule.
 */
interface WhatsAppOtpServiceInternals {
  hashOtpCode(phoneE164: string, code: string): string;
}

function internals(service: WhatsAppOtpService): WhatsAppOtpServiceInternals {
  return service as unknown as WhatsAppOtpServiceInternals;
}

describe('WhatsAppOtpService', () => {
  let service: WhatsAppOtpService;
  let prisma: PrismaService;
  let provider: RecordingOtpProvider;

  const appConfig = { devToolsEnabled: false };

  beforeEach(async () => {
    provider = new RecordingOtpProvider();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppOtpService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'app' ? appConfig : TEST_AUTH_CONFIG,
            ),
          },
        },
        { provide: WHATSAPP_OTP_PROVIDER, useValue: provider },
      ],
    }).compile();

    service = module.get(WhatsAppOtpService);
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    await prisma.phoneOtpChallenge.deleteMany({
      where: { phoneE164: { startsWith: TEST_FIXTURE_PHONE_PREFIX } },
    });
    await prisma.onModuleDestroy();
  });

  /**
   * Inserts a LIVE challenge directly, bypassing the service's own admission
   * control — so the database's `liveKey` uniqueness is what decides, which
   * is exactly what the positive control below is asserting.
   */
  async function insertLiveChallenge(
    phoneE164: string,
    createdAt: Date,
  ): Promise<string> {
    const row = await prisma.phoneOtpChallenge.create({
      data: {
        phoneE164,
        liveKey: phoneE164,
        codeHash: 'a'.repeat(64),
        expiresAt: new Date(createdAt.getTime() + OTP_TTL_MS),
        createdAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  describe('single-live-challenge invariant (Reviewer B, finding 1)', () => {
    it('POSITIVE CONTROL: the DATABASE refuses a second live challenge for one number', async () => {
      // This is the whole fix, asserted at the level it is actually enforced.
      // Admission control used to be "INSERT, then re-read and decide who
      // won", which under READ COMMITTED two concurrent callers could BOTH
      // win — their follow-up "retire the other challenge" writes then
      // crossed and could leave the number with NO usable code despite
      // messages having been delivered. That reproduced under real load: a
      // full parallel test run left a number with zero live challenges after
      // an eight-request burst.
      //
      // `PhoneOtpChallenge.liveKey` (a plain nullable `@unique`, the same
      // mechanism as `PaymentOrder.openOrderKey`) moved the decision into the
      // database, where it is atomic at any isolation level. If this
      // assertion ever stops holding, the index is gone and every test below
      // has become vacuous.
      const phone = fixturePhone();
      await insertLiveChallenge(phone, new Date());

      await expect(
        insertLiveChallenge(phone, new Date()),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('permits any number of CONSUMED challenges to coexist for one number', async () => {
      // The slot is released by setting `liveKey` to NULL, and Postgres
      // permits any number of NULLs in a unique index — which is what makes
      // "one LIVE challenge" expressible without a partial index (Prisma
      // cannot declare one, so `db push` and `migrate deploy` would have
      // produced different databases).
      const phone = fixturePhone();
      for (let i = 0; i < 3; i += 1) {
        await prisma.phoneOtpChallenge.create({
          data: {
            phoneE164: phone,
            liveKey: null,
            codeHash: 'a'.repeat(64),
            expiresAt: new Date(),
            consumedAt: new Date(),
          },
        });
      }

      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(3);
    });

    it('a burst of concurrent requests leaves exactly ONE live, verifiable code', async () => {
      const phone = fixturePhone();

      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => service.issueChallenge(phone, {})),
      );

      // Exactly ONE request claims the slot, so exactly ONE message is sent —
      // a burst must not turn into a burst of messages to a real person's
      // phone. Everything else is answered `cooldown`.
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(provider.sent.filter((s) => s.phoneE164 === phone)).toHaveLength(
        1,
      );
      for (const outcome of outcomes.filter(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      )) {
        expect(outcome.reason).toBeInstanceOf(OtpRequestThrottled);
      }

      const live = await prisma.phoneOtpChallenge.findMany({
        where: { phoneE164: phone, consumedAt: null },
      });
      expect(live).toHaveLength(1);
      expect(live[0].liveKey).toBe(phone);

      // And the delivered code genuinely works: a burst must never leave a
      // number able to receive codes but unable to sign in with any of them.
      await expect(
        service.claimChallenge(phone, provider.lastCodeFor(phone)),
      ).resolves.toBeUndefined();
    });

    it('releases the live slot the moment a challenge is consumed', async () => {
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});
      await service.claimChallenge(phone, provider.lastCodeFor(phone));

      const consumed = await prisma.phoneOtpChallenge.findFirstOrThrow({
        where: { phoneE164: phone },
      });
      // `consumedAt` and `liveKey` are written together, always — the
      // invariant depends on it.
      expect(consumed.consumedAt).not.toBeNull();
      expect(consumed.liveKey).toBeNull();

      // Consuming a code does NOT reset the rate limit, though: the cooldown
      // is about how often a message may be sent to this number, not about
      // whether the last one was used. A signed-in user asking for another
      // code one second later still waits.
      await expect(service.issueChallenge(phone, {})).rejects.toBeInstanceOf(
        OtpRequestThrottled,
      );
    });

    it('releases the live slot held by an EXPIRED challenge rather than blocking the number forever', async () => {
      // An expired-but-unconsumed row still occupies `liveKey`. If issuance
      // did not retire it first, every future request for that number would
      // lose the unique index and be reported as a cooldown — permanently.
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});
      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: {
          expiresAt: new Date(Date.now() - 1000),
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      });

      await expect(service.issueChallenge(phone, {})).resolves.toBeDefined();
      await expect(
        service.claimChallenge(phone, provider.lastCodeFor(phone)),
      ).resolves.toBeUndefined();
    });
  });

  describe('admission control', () => {
    it('refuses a resend inside the cooldown window and leaves no extra row', async () => {
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});

      await expect(service.issueChallenge(phone, {})).rejects.toBeInstanceOf(
        OtpRequestThrottled,
      );
      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(1);
    });

    it('allows a resend once the cooldown has elapsed, and retires the previous code', async () => {
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});
      const firstCode = provider.lastCodeFor(phone);

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });

      await service.issueChallenge(phone, {});

      // The retired code no longer works. The internal reason is
      // `otp_wrong_code` rather than `otp_not_found` because the OLD
      // challenge was consumed by the resend, so this guess is now compared
      // against the NEW live challenge — which is the honest description of
      // what happened. Either way the caller sees the same generic
      // `INVALID_OTP`.
      await expect(
        service.claimChallenge(phone, firstCode),
      ).rejects.toMatchObject({ reason: 'otp_wrong_code' });
      await expect(
        service.claimChallenge(phone, provider.lastCodeFor(phone)),
      ).resolves.toBeUndefined();
    });
  });

  describe('challenge verification', () => {
    it('reports a distinct internal reason for each failure mode', async () => {
      const phone = fixturePhone();

      await expect(
        service.claimChallenge(phone, '000000'),
      ).rejects.toMatchObject({ reason: 'otp_not_found' });

      await service.issueChallenge(phone, {});
      const code = provider.lastCodeFor(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      await expect(service.claimChallenge(phone, wrong)).rejects.toMatchObject({
        reason: 'otp_wrong_code',
      });

      await prisma.phoneOtpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(service.claimChallenge(phone, code)).rejects.toMatchObject({
        reason: 'otp_expired',
      });
    });

    it('enforces the attempt budget in the database, not in application code', async () => {
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});
      const code = provider.lastCodeFor(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      // Fired concurrently on purpose: a check-then-act implementation would
      // let every one of these through, because they would all read the same
      // `attemptCount` before any of them wrote.
      await Promise.allSettled(
        Array.from({ length: OTP_MAX_ATTEMPTS * 4 }, () =>
          service.claimChallenge(phone, wrong),
        ),
      );

      const challenge = await prisma.phoneOtpChallenge.findFirstOrThrow({
        where: { phoneE164: phone },
      });
      expect(challenge.attemptCount).toBeLessThanOrEqual(OTP_MAX_ATTEMPTS);

      await expect(service.claimChallenge(phone, code)).rejects.toBeInstanceOf(
        OtpRejected,
      );
    });

    it('consumes a challenge exactly once under concurrent correct guesses', async () => {
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});
      const code = provider.lastCodeFor(phone);

      const outcomes = await Promise.allSettled([
        service.claimChallenge(phone, code),
        service.claimChallenge(phone, code),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('code handling', () => {
    it('generates a fixed-length numeric code and never persists it', async () => {
      const phone = fixturePhone();
      await service.issueChallenge(phone, {});
      const code = provider.lastCodeFor(phone);

      expect(code).toMatch(/^\d{6}$/);
      const challenge = await prisma.phoneOtpChallenge.findFirstOrThrow({
        where: { phoneE164: phone },
      });
      expect(challenge.codeHash).not.toContain(code);
    });

    it('produces a different hash for the same code on a different number', () => {
      // Phone binding: without it, one precomputed table of HMAC(secret,
      // code) would cover every 6-digit code this system ever issues.
      const phoneA = fixturePhone();
      const phoneB = fixturePhone();
      const hash = (phone: string, code: string): string =>
        internals(service).hashOtpCode(phone, code);

      expect(hash(phoneA, '123456')).not.toBe(hash(phoneB, '123456'));
      expect(hash(phoneA, '123456')).toBe(hash(phoneA, '123456'));
    });

    it('withholds the plaintext code from the issuance result unless dev tools are enabled', async () => {
      const phone = fixturePhone();

      appConfig.devToolsEnabled = false;
      expect((await service.issueChallenge(phone, {})).devCode).toBeUndefined();

      await prisma.phoneOtpChallenge.deleteMany({
        where: { phoneE164: phone },
      });
      appConfig.devToolsEnabled = true;
      expect((await service.issueChallenge(phone, {})).devCode).toBe(
        provider.lastCodeFor(phone),
      );
      appConfig.devToolsEnabled = false;
    });

    it('reports no local fake provider when a different implementation is bound', () => {
      expect(service.localFakeProvider).toBeUndefined();
    });
  });
});
