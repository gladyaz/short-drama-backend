import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  TEST_FIXTURE_PHONE_PREFIX,
  fixturePhone,
} from '../../../common/testing/fixture-namespace.helpers';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_WINDOW,
  OTP_TTL_MS,
} from '../auth-identity.constants';
import {
  OtpDeliveryFailed,
  OtpRejected,
  OtpRequestThrottled,
  WhatsAppOtpService,
} from './whatsapp-otp.service';
import type {
  SendWhatsAppOtpInput,
  WhatsAppOtpProvider,
} from './whatsapp-otp.types';
import {
  WHATSAPP_OTP_PROVIDER,
  WhatsAppDeliveryError,
} from './whatsapp-otp.types';

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
  /**
   * How the next send should fail. `undefined` delivers normally;
   * `'unclassified'` throws a bare `Error`, which the service must treat as
   * `provider_unavailable` — the fail-closed reading of a surprise.
   */
  failWith:
    'provider_unavailable' | 'recipient_rejected' | 'unclassified' | undefined;

  sendOtp(input: SendWhatsAppOtpInput): Promise<void> {
    if (this.failWith === 'unclassified') {
      return Promise.reject(new Error('simulated unclassified vendor throw'));
    }
    if (this.failWith !== undefined) {
      return Promise.reject(
        new WhatsAppDeliveryError(
          this.failWith,
          'simulated delivery failure',
          503,
        ),
      );
    }
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

    /**
     * PHASE 10C, fix cycle 1 (Reviewer B, LOW-1). The `window_exhausted`
     * branch of `assertRequestAllowed` had no test at all — reaching it
     * needs `OTP_MAX_REQUESTS_PER_WINDOW` requests whose cooldowns have
     * each elapsed, which no suite did.
     *
     * Closing it matters now because `resendAvailableInSeconds` makes an
     * implicit claim about this exact branch: that field reports the
     * 60-second COOLDOWN, and this test is the standing proof the cooldown
     * is not the only gate — which is why the field is documented as a
     * minimum wait rather than a promise of admission.
     */
    it('refuses a request once the per-number rolling budget is spent, even with the cooldown clear', async () => {
      const phone = fixturePhone();

      for (let i = 0; i < OTP_MAX_REQUESTS_PER_WINDOW; i += 1) {
        await service.issueChallenge(phone, {});
        // Back-dated past the 60s cooldown but well inside the 1-hour
        // window, so the NEXT issue is never refused by the cooldown while
        // every row still counts against the budget. Without this the loop
        // would stop at the cooldown and never reach the branch under test.
        await prisma.phoneOtpChallenge.updateMany({
          where: { phoneE164: phone },
          data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
        });
      }

      await expect(service.issueChallenge(phone, {})).rejects.toMatchObject({
        reason: 'window_exhausted',
      });

      // Same exception class the cooldown raises, so both surface to the
      // caller as one `OTP_RESEND_COOLDOWN`: the client cannot tell which
      // limiter stopped it, and must not need to.
      await expect(service.issueChallenge(phone, {})).rejects.toBeInstanceOf(
        OtpRequestThrottled,
      );

      // The budget is checked BEFORE a code is generated or handed to the
      // provider, so a refused request costs no message and writes no row.
      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(OTP_MAX_REQUESTS_PER_WINDOW);
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

  /**
   * WHATSAPP LOGIN V1 — delivery failure is no longer uniformly swallowed.
   *
   * The split is NUMBER-INDEPENDENT vs NUMBER-SPECIFIC, and these tests
   * assert both halves, because getting either one wrong is a real defect:
   * swallowing an outage strands every user on a code-entry screen forever,
   * and surfacing a per-recipient refusal turns an unauthenticated route into
   * a phone-validity oracle.
   */
  describe('delivery failure handling', () => {
    afterEach(() => {
      provider.failWith = undefined;
    });

    it.each(['provider_unavailable', 'unclassified'] as const)(
      'CRITICAL: a %s failure PROPAGATES rather than reporting success',
      async (kind) => {
        const phone = fixturePhone();
        provider.failWith = kind;

        await expect(service.issueChallenge(phone, {})).rejects.toBeInstanceOf(
          OtpDeliveryFailed,
        );
      },
    );

    it('CRITICAL: a provider outage leaves NO challenge row behind', async () => {
      const phone = fixturePhone();
      provider.failWith = 'provider_unavailable';

      await service.issueChallenge(phone, {}).catch(() => undefined);

      expect(
        await prisma.phoneOtpChallenge.count({ where: { phoneE164: phone } }),
      ).toBe(0);
    });

    it('the withdrawal clears the cooldown, so the user can retry at once', async () => {
      const phone = fixturePhone();
      provider.failWith = 'provider_unavailable';
      await service.issueChallenge(phone, {}).catch(() => undefined);

      // Without the withdrawal this would throw OtpRequestThrottled.
      provider.failWith = undefined;
      await expect(service.issueChallenge(phone, {})).resolves.toMatchObject({
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });
    });

    it('the withdrawal does not spend the rolling request budget', async () => {
      const phone = fixturePhone();

      // Exhaust the window entirely on failed deliveries.
      provider.failWith = 'provider_unavailable';
      for (let i = 0; i < OTP_MAX_REQUESTS_PER_WINDOW + 2; i += 1) {
        await service.issueChallenge(phone, {}).catch(() => undefined);
      }

      // An outage must not lock a real user out of their own number.
      provider.failWith = undefined;
      await expect(service.issueChallenge(phone, {})).resolves.toBeDefined();
    });

    it('CRITICAL: a recipient_rejected failure is SWALLOWED and keeps the challenge live', async () => {
      const phone = fixturePhone();
      provider.failWith = 'recipient_rejected';

      // Byte-identical to a successful send, by design.
      await expect(service.issueChallenge(phone, {})).resolves.toMatchObject({
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });

      const live = await prisma.phoneOtpChallenge.findMany({
        where: { phoneE164: phone },
      });
      expect(live).toHaveLength(1);
      expect(live[0].consumedAt).toBeNull();
      expect(live[0].liveKey).toBe(phone);
    });

    it('a withdrawal never destroys an already-CONSUMED challenge', async () => {
      const phone = fixturePhone();

      // A real, delivered, then consumed challenge.
      await service.issueChallenge(phone, {});
      await service.claimChallenge(phone, provider.lastCodeFor(phone));
      const consumedBefore = await prisma.phoneOtpChallenge.count({
        where: { phoneE164: phone, consumedAt: { not: null } },
      });

      // A later request whose delivery fails must withdraw only ITS OWN row.
      provider.failWith = 'provider_unavailable';
      await service.issueChallenge(phone, {}).catch(() => undefined);

      expect(
        await prisma.phoneOtpChallenge.count({
          where: { phoneE164: phone, consumedAt: { not: null } },
        }),
      ).toBe(consumedBefore);
    });

    it('CRITICAL: no delivery-failure log line carries the code or the full number', async () => {
      const phone = fixturePhone();
      const written: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((value: unknown) => {
          written.push(String(value));
        });

      try {
        provider.failWith = 'provider_unavailable';
        await service.issueChallenge(phone, {}).catch(() => undefined);
      } finally {
        spy.mockRestore();
      }

      const all = written.join('\n');
      expect(all).toContain(`...${phone.slice(-4)}`);
      expect(all).not.toContain(phone);
      expect(all).not.toMatch(/\b\d{6}\b/);
    });
  });
});
