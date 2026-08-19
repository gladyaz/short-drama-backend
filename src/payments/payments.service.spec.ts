import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { fixtureEmail } from '../common/testing/fixture-namespace.helpers';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PLANS, findPaymentPlan } from './payment-plan.constants';
import { PaymentsService } from './payments.service';
import { MIDTRANS_GATEWAY } from './midtrans/midtrans.types';
import type {
  MidtransGateway,
  MidtransSnapCheckout,
} from './midtrans/midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": integration-style spec
 * (the `entitlements.service.spec.ts` precedent) — real `PrismaService`
 * against the project's Postgres test database, self-cleaning, with the
 * Midtrans gateway FAKED at its DI token: no test here can reach any
 * provider host.
 */
describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: PrismaService;
  let userId: string;
  const createdUserIds: string[] = [];

  const paymentsConfig = {
    enabled: true,
    midtransServerKey: 'unit-test-server-key',
    midtransIsProduction: false,
  };

  let snapCalls: Array<{
    orderId: string;
    grossAmountIdr: number;
    expiryMinutes: number;
  }>;
  let snapImplementation: (input: {
    orderId: string;
    grossAmountIdr: number;
    expiryMinutes: number;
  }) => Promise<MidtransSnapCheckout>;

  const gatewayFake: MidtransGateway = {
    createSnapTransaction: (input) => {
      snapCalls.push(input);
      return snapImplementation(input);
    },
    getTransactionStatus: () => Promise.resolve({ found: false }),
  };

  beforeEach(async () => {
    snapCalls = [];
    snapImplementation = (input) =>
      Promise.resolve({
        token: `tok-${input.orderId}`,
        redirectUrl: `https://app.sandbox.midtrans.com/snap/v3/redirection/tok-${input.orderId}`,
      });
    paymentsConfig.enabled = true;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        PrismaService,
        {
          provide: ConfigService,
          useValue: { get: () => paymentsConfig },
        },
        { provide: MIDTRANS_GATEWAY, useValue: gatewayFake },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('payments-service-spec'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
    createdUserIds.push(userId);
  });

  afterEach(async () => {
    await prisma.paymentOrder.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.entitlement.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
    await prisma.onModuleDestroy();
  });

  describe('createCheckout — validation and pricing authority', () => {
    it('rejects an unknown plan with PAYMENT_PLAN_NOT_FOUND', async () => {
      await expect(
        service.createCheckout(userId, 'premium-lifetime-999'),
      ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_NOT_FOUND' });
      expect(snapCalls).toHaveLength(0);
    });

    it('rejects with PAYMENTS_DISABLED when the flag is off', async () => {
      paymentsConfig.enabled = false;
      await expect(
        service.createCheckout(userId, 'premium-30d'),
      ).rejects.toMatchObject({ code: 'PAYMENTS_DISABLED' });
    });

    it('CRITICAL: the charged amount comes from the server catalog, never the caller', async () => {
      const plan = findPaymentPlan('premium-30d')!;
      const result = await service.createCheckout(userId, 'premium-30d');

      expect(result.amountIdr).toBe(plan.priceIdr);
      expect(result.currency).toBe('IDR');
      expect(result.status).toBe('PENDING');
      expect(result.checkoutUrl).toContain('snap/v3/redirection');

      expect(snapCalls).toEqual([
        expect.objectContaining({ grossAmountIdr: plan.priceIdr }),
      ]);

      const row = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: result.orderId },
      });
      expect(row.amountIdr).toBe(plan.priceIdr);
      expect(row.entitlementDurationDays).toBe(plan.durationDays);
      expect(row.provider).toBe('midtrans');
      expect(row.snapToken).toBe(`tok-${row.providerOrderId}`);
    });

    it('generates unique, contract-safe provider order ids', async () => {
      const first = await service.createCheckout(userId, 'premium-7d');
      const second = await service.createCheckout(userId, 'premium-30d');

      for (const providerOrderId of [
        first.providerOrderId,
        second.providerOrderId,
      ]) {
        expect(providerOrderId).toMatch(/^sd-[0-9a-f-]{36}$/);
        expect(providerOrderId.length).toBeLessThanOrEqual(50);
      }
      expect(first.providerOrderId).not.toBe(second.providerOrderId);
    });
  });

  describe('createCheckout — idempotency (openOrderKey)', () => {
    it('a retried checkout returns the SAME open order without a second provider call', async () => {
      const first = await service.createCheckout(userId, 'premium-30d');
      const second = await service.createCheckout(userId, 'premium-30d');

      expect(second.orderId).toBe(first.orderId);
      expect(second.checkoutUrl).toBe(first.checkoutUrl);
      expect(snapCalls).toHaveLength(1);

      const rows = await prisma.paymentOrder.findMany({
        where: { userId, planId: 'premium-30d' },
      });
      expect(rows).toHaveLength(1);
    });

    it('CRITICAL: two concurrent checkouts for the same plan create exactly one chargeable order', async () => {
      snapImplementation = async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return {
          token: `tok-${input.orderId}`,
          redirectUrl: `https://app.sandbox.midtrans.com/snap/v3/redirection/tok-${input.orderId}`,
        };
      };

      const results = await Promise.allSettled([
        service.createCheckout(userId, 'premium-30d'),
        service.createCheckout(userId, 'premium-30d'),
      ]);

      const fulfilled = results.filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<PaymentsService['createCheckout']>>
        > => r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const orderIds = new Set(fulfilled.map((r) => r.value.orderId));
      expect(orderIds.size).toBe(1);
      for (const rejection of rejected) {
        expect(rejection.reason).toMatchObject({
          code: 'PAYMENT_CHECKOUT_IN_PROGRESS',
        });
      }

      // Exactly one provider transaction was ever created for the pair.
      expect(snapCalls).toHaveLength(1);
      const rows = await prisma.paymentOrder.findMany({
        where: { userId, planId: 'premium-30d' },
      });
      expect(rows).toHaveLength(1);
    });

    it('a fresh in-flight CREATED order answers 409 rather than double-charging', async () => {
      await prisma.paymentOrder.create({
        data: {
          userId,
          provider: 'midtrans',
          providerOrderId: `sd-${randomUUID()}`,
          planId: 'premium-30d',
          amountIdr: 49000,
          currency: 'IDR',
          status: 'CREATED',
          openOrderKey: `${userId}:premium-30d`,
          entitlementDurationDays: 30,
          checkoutExpiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });

      await expect(
        service.createCheckout(userId, 'premium-30d'),
      ).rejects.toMatchObject({ code: 'PAYMENT_CHECKOUT_IN_PROGRESS' });
      expect(snapCalls).toHaveLength(0);
    });

    it('reclaims a crashed CREATED order past the stuck threshold and creates a fresh one', async () => {
      const stuck = await prisma.paymentOrder.create({
        data: {
          userId,
          provider: 'midtrans',
          providerOrderId: `sd-${randomUUID()}`,
          planId: 'premium-30d',
          amountIdr: 49000,
          currency: 'IDR',
          status: 'CREATED',
          openOrderKey: `${userId}:premium-30d`,
          entitlementDurationDays: 30,
          checkoutExpiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      await prisma.paymentOrder.update({
        where: { id: stuck.id },
        data: { createdAt: new Date(Date.now() - 6 * 60_000) },
      });

      const result = await service.createCheckout(userId, 'premium-30d');

      expect(result.orderId).not.toBe(stuck.id);
      expect(result.status).toBe('PENDING');
      const reclaimed = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: stuck.id },
      });
      expect(reclaimed.status).toBe('FAILED');
      expect(reclaimed.failureCode).toBe('CHECKOUT_ABANDONED');
      expect(reclaimed.openOrderKey).toBeNull();
    });

    it('locally expires an open order whose payment window elapsed, then creates a fresh one', async () => {
      const dead = await prisma.paymentOrder.create({
        data: {
          userId,
          provider: 'midtrans',
          providerOrderId: `sd-${randomUUID()}`,
          planId: 'premium-30d',
          amountIdr: 49000,
          currency: 'IDR',
          status: 'PENDING',
          openOrderKey: `${userId}:premium-30d`,
          checkoutUrl: 'https://app.sandbox.midtrans.com/snap/v3/redirection/x',
          entitlementDurationDays: 30,
          checkoutExpiresAt: new Date(Date.now() - 60_000),
        },
      });

      const result = await service.createCheckout(userId, 'premium-30d');

      expect(result.orderId).not.toBe(dead.id);
      const expired = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: dead.id },
      });
      expect(expired.status).toBe('EXPIRED');
      expect(expired.failureCode).toBe('CHECKOUT_WINDOW_ELAPSED');
      expect(expired.openOrderKey).toBeNull();
    });
  });

  describe('createCheckout — provider failure', () => {
    it('CRITICAL: a Snap create failure records a FAILED order, frees the slot, and grants nothing', async () => {
      snapImplementation = () =>
        Promise.reject(new Error('provider outage (unit fixture)'));

      await expect(
        service.createCheckout(userId, 'premium-30d'),
      ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });

      const rows = await prisma.paymentOrder.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('FAILED');
      expect(rows[0].failureCode).toBe('PROVIDER_CREATE_FAILED');
      expect(rows[0].openOrderKey).toBeNull();

      const entitlements = await prisma.entitlement.findMany({
        where: { userId },
      });
      expect(entitlements).toHaveLength(0);

      // The freed slot lets the user retry successfully.
      snapImplementation = (input) =>
        Promise.resolve({
          token: `tok-${input.orderId}`,
          redirectUrl: `https://app.sandbox.midtrans.com/snap/v3/redirection/tok-${input.orderId}`,
        });
      const retry = await service.createCheckout(userId, 'premium-30d');
      expect(retry.status).toBe('PENDING');
      expect(retry.orderId).not.toBe(rows[0].id);
    });
  });

  describe('getOrderForUser — owner isolation', () => {
    it('serves the owner by internal id AND by provider order id', async () => {
      const checkout = await service.createCheckout(userId, 'premium-7d');

      const byInternal = await service.getOrderForUser(
        userId,
        checkout.orderId,
      );
      expect(byInternal.orderId).toBe(checkout.orderId);
      expect(byInternal.isPaid).toBe(false);

      const byProvider = await service.getOrderForUser(
        userId,
        checkout.providerOrderId,
      );
      expect(byProvider.orderId).toBe(checkout.orderId);
    });

    it("CRITICAL: another user's order reads as the same 404 as a nonexistent one", async () => {
      const checkout = await service.createCheckout(userId, 'premium-7d');
      const otherUser = await prisma.user.create({
        data: {
          email: fixtureEmail('payments-service-spec-other'),
          passwordHash: 'irrelevant-for-this-spec',
        },
      });
      createdUserIds.push(otherUser.id);

      await expect(
        service.getOrderForUser(otherUser.id, checkout.orderId),
      ).rejects.toMatchObject({ code: 'PAYMENT_ORDER_NOT_FOUND' });
      await expect(
        service.getOrderForUser(otherUser.id, 'sd-does-not-exist'),
      ).rejects.toMatchObject({ code: 'PAYMENT_ORDER_NOT_FOUND' });
    });
  });

  describe('security — Server Key never enters a response', () => {
    it('checkout and status responses never contain the configured key', async () => {
      const checkout = await service.createCheckout(userId, 'premium-30d');
      const status = await service.getOrderForUser(userId, checkout.orderId);

      const serialized = JSON.stringify({ checkout, status });
      expect(serialized).not.toContain(paymentsConfig.midtransServerKey);
    });
  });

  it('every catalog plan checks out with its own catalog price', async () => {
    for (const plan of PAYMENT_PLANS) {
      const result = await service.createCheckout(userId, plan.id);
      expect(result.amountIdr).toBe(plan.priceIdr);
      expect(result.planId).toBe(plan.id);
    }
  });
});
