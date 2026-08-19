import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PaymentOrder } from '@prisma/client';
import { fixtureEmail } from '../common/testing/fixture-namespace.helpers';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentNotificationService } from './payment-notification.service';
import { computeMidtransSignatureKey } from './midtrans/midtrans-signature.util';
import { MIDTRANS_GATEWAY } from './midtrans/midtrans.types';
import type {
  MidtransGateway,
  MidtransTransactionStatusResult,
} from './midtrans/midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": webhook +
 * reconciliation processing against a REAL Postgres database (the
 * `entitlements.service.spec.ts` precedent) with a REAL
 * `EntitlementsService`, so the exactly-once entitlement guarantees are
 * exercised through actual transactions, CAS writes, and row locks — not
 * through mocks agreeing with themselves. The provider gateway is faked at
 * its DI token; nothing here can reach a Midtrans host.
 */
const SERVER_KEY = 'unit-test-server-key';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('PaymentNotificationService', () => {
  let service: PaymentNotificationService;
  let prisma: PrismaService;
  let userId: string;
  const createdUserIds: string[] = [];

  const paymentsConfig = {
    enabled: true,
    midtransServerKey: SERVER_KEY,
    midtransIsProduction: false,
  };

  let statusResult: MidtransTransactionStatusResult;
  let statusShouldThrow = false;

  const gatewayFake: MidtransGateway = {
    createSnapTransaction: () =>
      Promise.reject(new Error('not used by this spec')),
    getTransactionStatus: () =>
      statusShouldThrow
        ? Promise.reject(new Error('provider outage (unit fixture)'))
        : Promise.resolve(statusResult),
  };

  beforeEach(async () => {
    paymentsConfig.enabled = true;
    statusResult = { found: false };
    statusShouldThrow = false;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentNotificationService,
        EntitlementsService,
        PrismaService,
        { provide: ConfigService, useValue: { get: () => paymentsConfig } },
        { provide: MIDTRANS_GATEWAY, useValue: gatewayFake },
      ],
    }).compile();

    service = module.get<PaymentNotificationService>(
      PaymentNotificationService,
    );
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();

    const user = await prisma.user.create({
      data: {
        email: fixtureEmail('payment-notification-spec'),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
    userId = user.id;
    createdUserIds.push(userId);
  });

  afterEach(async () => {
    await prisma.paymentOrder.deleteMany({
      where: {
        OR: [
          { userId: { in: createdUserIds } },
          { providerOrderId: { startsWith: 'sd-spec-' }, userId: null },
        ],
      },
    });
    await prisma.entitlement.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
    await prisma.onModuleDestroy();
  });

  async function createOrder(
    overrides: Partial<{
      userId: string | null;
      planId: string;
      amountIdr: number;
      status: string;
      entitlementDurationDays: number;
    }> = {},
  ): Promise<PaymentOrder> {
    return prisma.paymentOrder.create({
      data: {
        userId: overrides.userId === undefined ? userId : overrides.userId,
        provider: 'midtrans',
        providerOrderId: `sd-spec-${randomUUID()}`,
        planId: overrides.planId ?? 'premium-30d',
        amountIdr: overrides.amountIdr ?? 49000,
        currency: 'IDR',
        status: overrides.status ?? 'PENDING',
        entitlementDurationDays: overrides.entitlementDurationDays ?? 30,
        checkoutExpiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
  }

  /** Builds a Midtrans-shaped notification whose signature is AUTHENTIC for the given fields. */
  function signedNotification(
    order: PaymentOrder,
    overrides: Partial<{
      order_id: string;
      status_code: string;
      gross_amount: string;
      transaction_status: string;
      fraud_status: string;
      transaction_id: string;
      signature_key: string;
    }> = {},
  ): Record<string, unknown> {
    const base = {
      order_id: overrides.order_id ?? order.providerOrderId,
      status_code: overrides.status_code ?? '200',
      gross_amount: overrides.gross_amount ?? `${order.amountIdr}.00`,
      transaction_status: overrides.transaction_status ?? 'settlement',
    };
    return {
      ...base,
      ...(overrides.fraud_status !== undefined
        ? { fraud_status: overrides.fraud_status }
        : {}),
      ...(overrides.transaction_id !== undefined
        ? { transaction_id: overrides.transaction_id }
        : {}),
      signature_key:
        overrides.signature_key ??
        computeMidtransSignatureKey({
          orderId: base.order_id,
          statusCode: base.status_code,
          grossAmount: base.gross_amount,
          serverKey: SERVER_KEY,
        }),
      // A field this backend has never heard of — must be tolerated.
      some_future_provider_field: { nested: true },
    };
  }

  describe('authenticity gates', () => {
    it('rejects a malformed body with PAYMENT_NOTIFICATION_INVALID before any signature math', async () => {
      await expect(service.processNotification(null)).rejects.toMatchObject({
        code: 'PAYMENT_NOTIFICATION_INVALID',
      });
      await expect(service.processNotification([])).rejects.toMatchObject({
        code: 'PAYMENT_NOTIFICATION_INVALID',
      });
      await expect(
        service.processNotification({ order_id: 'sd-x' }),
      ).rejects.toMatchObject({ code: 'PAYMENT_NOTIFICATION_INVALID' });
      await expect(
        service.processNotification({
          order_id: 'sd-x',
          status_code: 200, // number, not string
          gross_amount: '1.00',
          signature_key: 'a',
          transaction_status: 'settlement',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_NOTIFICATION_INVALID' });
    });

    it('CRITICAL: rejects a forged signature and transitions nothing', async () => {
      const order = await createOrder();
      const forged = signedNotification(order, {
        signature_key: computeMidtransSignatureKey({
          orderId: order.providerOrderId,
          statusCode: '200',
          grossAmount: `${order.amountIdr}.00`,
          serverKey: 'attacker-key',
        }),
      });

      await expect(service.processNotification(forged)).rejects.toMatchObject({
        code: 'PAYMENT_NOTIFICATION_REJECTED',
      });

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PENDING');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
    });

    it('CRITICAL: rejects an authentic-signature notification whose amount does not match the order', async () => {
      const order = await createOrder({ amountIdr: 49000 });
      // The attacker signs a REAL-looking payload for the wrong amount —
      // the signature is internally consistent, the order check kills it.
      const spliced = signedNotification(order, { gross_amount: '1.00' });

      await expect(service.processNotification(spliced)).rejects.toMatchObject({
        code: 'PAYMENT_NOTIFICATION_REJECTED',
      });

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PENDING');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
    });

    it('answers an unknown (but authentic-shaped) order with PAYMENT_ORDER_NOT_FOUND', async () => {
      const ghost = {
        order_id: `sd-spec-${randomUUID()}`,
        status_code: '200',
        gross_amount: '49000.00',
        transaction_status: 'settlement',
      };
      await expect(
        service.processNotification({
          ...ghost,
          signature_key: computeMidtransSignatureKey({
            orderId: ghost.order_id,
            statusCode: ghost.status_code,
            grossAmount: ghost.gross_amount,
            serverKey: SERVER_KEY,
          }),
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_ORDER_NOT_FOUND' });
    });

    it('rejects everything with PAYMENTS_DISABLED while the flag is off', async () => {
      paymentsConfig.enabled = false;
      await expect(service.processNotification({})).rejects.toMatchObject({
        code: 'PAYMENTS_DISABLED',
      });
    });
  });

  describe('success path — PAID CAS + exactly-once entitlement', () => {
    it('an authentic settlement marks the order PAID and grants premium exactly once', async () => {
      const order = await createOrder();
      const before = Date.now();

      await expect(
        service.processNotification(
          signedNotification(order, { transaction_id: 'mid-tx-1' }),
        ),
      ).resolves.toEqual({ status: 'ok' });

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PAID');
      expect(fresh.paidAt).not.toBeNull();
      expect(fresh.openOrderKey).toBeNull();
      expect(fresh.providerTransactionId).toBe('mid-tx-1');
      expect(fresh.providerTransactionStatus).toBe('settlement');
      expect(fresh.entitlementId).not.toBeNull();

      const entitlements = await prisma.entitlement.findMany({
        where: { userId },
      });
      expect(entitlements).toHaveLength(1);
      expect(entitlements[0].id).toBe(fresh.entitlementId);
      expect(entitlements[0].tier).toBe('premium');
      expect(entitlements[0].source).toBe('midtrans');
      const expectedExpiry = before + 30 * DAY_MS;
      expect(
        Math.abs(entitlements[0].expiresAt!.getTime() - expectedExpiry),
      ).toBeLessThan(120_000);
    });

    it('CRITICAL: a duplicate settlement webhook grants nothing twice and never moves paidAt', async () => {
      const order = await createOrder();
      const notification = signedNotification(order);

      await service.processNotification(notification);
      const afterFirst = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });

      await expect(service.processNotification(notification)).resolves.toEqual({
        status: 'ok',
      });

      const afterSecond = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(afterSecond.paidAt?.getTime()).toBe(afterFirst.paidAt?.getTime());
      expect(afterSecond.entitlementId).toBe(afterFirst.entitlementId);
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('CRITICAL: simultaneous success delivery activates premium exactly once', async () => {
      const order = await createOrder();
      const notification = signedNotification(order);

      const results = await Promise.all([
        service.processNotification(notification),
        service.processNotification(notification),
      ]);
      expect(results).toEqual([{ status: 'ok' }, { status: 'ok' }]);

      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PAID');
    });

    it('CRITICAL: a delayed pending notification never downgrades a PAID order', async () => {
      const order = await createOrder();
      await service.processNotification(signedNotification(order));

      await expect(
        service.processNotification(
          signedNotification(order, {
            transaction_status: 'pending',
            status_code: '201',
          }),
        ),
      ).resolves.toEqual({ status: 'ok' });

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PAID');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('pending then settlement upgrades exactly once', async () => {
      const order = await createOrder({ status: 'CREATED' });

      await service.processNotification(
        signedNotification(order, {
          transaction_status: 'pending',
          status_code: '201',
        }),
      );
      let fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PENDING');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);

      await service.processNotification(signedNotification(order));
      fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PAID');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('CRITICAL: two different paid orders stack the entitlement duration', async () => {
      const week = await createOrder({
        planId: 'premium-7d',
        amountIdr: 19000,
        entitlementDurationDays: 7,
      });
      const month = await createOrder({
        planId: 'premium-30d',
        amountIdr: 49000,
        entitlementDurationDays: 30,
      });

      await service.processNotification(signedNotification(week));
      await service.processNotification(signedNotification(month));

      const entitlements = await prisma.entitlement.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(entitlements).toHaveLength(2);
      // The second purchase extends FROM the first one's expiry — exactly
      // 30 more days, not 30 days from "now".
      expect(
        entitlements[1].expiresAt!.getTime() -
          entitlements[0].expiresAt!.getTime(),
      ).toBe(30 * DAY_MS);
    });

    it('CRITICAL: two DIFFERENT orders settling SIMULTANEOUSLY stack without losing purchased time (Reviewer B fix cycle 1)', async () => {
      // Unlike the duplicate-delivery test above (same order twice, fully
      // guarded by the status CAS alone), this exercises the per-user
      // `FOR UPDATE` serialization in `grantPaidPremium`: without it, both
      // grants could read the same pre-existing expiry and one purchased
      // period would silently vanish.
      const week = await createOrder({
        planId: 'premium-7d',
        amountIdr: 19000,
        entitlementDurationDays: 7,
      });
      const month = await createOrder({
        planId: 'premium-30d',
        amountIdr: 49000,
        entitlementDurationDays: 30,
      });

      const before = Date.now();
      await Promise.all([
        service.processNotification(signedNotification(week)),
        service.processNotification(signedNotification(month)),
      ]);

      const entitlements = await prisma.entitlement.findMany({
        where: { userId },
      });
      expect(entitlements).toHaveLength(2);

      // Regardless of which settlement won the race, the LATEST expiry
      // must cover the full 7 + 30 purchased days from now — a lost-update
      // race would leave it at only 7 or only 30.
      const latestExpiry = Math.max(
        ...entitlements.map((row) => row.expiresAt!.getTime()),
      );
      expect(Math.abs(latestExpiry - (before + 37 * DAY_MS))).toBeLessThan(
        120_000,
      );
    });

    it('a paid order whose user was deleted is recorded PAID with no grant and no crash', async () => {
      const doomedUser = await prisma.user.create({
        data: {
          email: fixtureEmail('payment-notification-spec-doomed'),
          passwordHash: 'irrelevant-for-this-spec',
        },
      });
      const order = await createOrder({ userId: doomedUser.id });
      await prisma.user.delete({ where: { id: doomedUser.id } });

      await expect(
        service.processNotification(signedNotification(order)),
      ).resolves.toEqual({ status: 'ok' });

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PAID');
      expect(fresh.userId).toBeNull();
      expect(fresh.entitlementId).toBeNull();
    });
  });

  describe('fraud and failure semantics', () => {
    it('capture + fraud accept grants premium', async () => {
      const order = await createOrder();
      await service.processNotification(
        signedNotification(order, {
          transaction_status: 'capture',
          fraud_status: 'accept',
        }),
      );
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('CRITICAL: capture + fraud challenge stays PENDING and grants nothing', async () => {
      const order = await createOrder();
      await service.processNotification(
        signedNotification(order, {
          transaction_status: 'capture',
          fraud_status: 'challenge',
        }),
      );

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PENDING');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
    });

    it.each([
      ['deny', 'FAILED', undefined],
      ['failure', 'FAILED', undefined],
      ['cancel', 'CANCELED', undefined],
      ['expire', 'EXPIRED', undefined],
      ['capture', 'FAILED', 'deny'],
    ] as const)(
      'transaction_status %s -> %s (fraud_status %s) grants nothing',
      async (transactionStatus, expectedState, fraudStatus) => {
        const order = await createOrder();
        await service.processNotification(
          signedNotification(order, {
            transaction_status: transactionStatus,
            ...(fraudStatus ? { fraud_status: fraudStatus } : {}),
            status_code: '200',
          }),
        );

        const fresh = await prisma.paymentOrder.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(fresh.status).toBe(expectedState);
        expect(fresh.openOrderKey).toBeNull();
        expect(fresh.providerTransactionStatus).toBe(transactionStatus);
        expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
      },
    );

    it('refund after settlement records REFUNDED (entitlement handling is an explicit follow-up)', async () => {
      const order = await createOrder();
      await service.processNotification(signedNotification(order));
      await service.processNotification(
        signedNotification(order, { transaction_status: 'refund' }),
      );

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('REFUNDED');
      // Deliberate: this slice records the refund; automatic revocation is
      // a product decision documented as remaining work.
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('an unknown transaction_status is acknowledged and changes nothing', async () => {
      const order = await createOrder();
      await expect(
        service.processNotification(
          signedNotification(order, {
            transaction_status: 'some-future-status',
          }),
        ),
      ).resolves.toEqual({ status: 'ok' });

      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PENDING');
    });
  });

  describe('reconcilePayment — GET Status reconciliation', () => {
    it('applies an authoritative settlement read exactly like a webhook (once)', async () => {
      const order = await createOrder();
      statusResult = {
        found: true,
        orderId: order.providerOrderId,
        transactionStatus: 'settlement',
        statusCode: '200',
        fraudStatus: 'accept',
        transactionId: 'mid-tx-recon',
        grossAmount: `${order.amountIdr}.00`,
      };

      const result = await service.reconcilePayment(order.id);
      expect(result.status).toBe('PAID');
      expect(result.isPaid).toBe(true);
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);

      // Reconciling again is idempotent.
      const again = await service.reconcilePayment(order.providerOrderId);
      expect(again.status).toBe('PAID');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
    });

    it('a transaction Midtrans does not know leaves local state untouched', async () => {
      const order = await createOrder();
      statusResult = { found: false };

      const result = await service.reconcilePayment(order.id);
      expect(result.status).toBe('PENDING');
    });

    it('a provider outage surfaces as PAYMENT_PROVIDER_ERROR without state change', async () => {
      const order = await createOrder();
      statusShouldThrow = true;

      await expect(service.reconcilePayment(order.id)).rejects.toMatchObject({
        code: 'PAYMENT_PROVIDER_ERROR',
      });
      const fresh = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(fresh.status).toBe('PENDING');
    });

    it('an amount mismatch on the provider read refuses to transition', async () => {
      const order = await createOrder({ amountIdr: 49000 });
      statusResult = {
        found: true,
        orderId: order.providerOrderId,
        transactionStatus: 'settlement',
        statusCode: '200',
        grossAmount: '1.00',
      };

      const result = await service.reconcilePayment(order.id);
      expect(result.status).toBe('PENDING');
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
    });

    it('an unknown order ref answers PAYMENT_ORDER_NOT_FOUND', async () => {
      await expect(
        service.reconcilePayment('sd-spec-never-existed'),
      ).rejects.toMatchObject({ code: 'PAYMENT_ORDER_NOT_FOUND' });
    });
  });

  describe('security — Server Key never leaks through this surface', () => {
    it('acks and error objects never contain the configured key', async () => {
      const order = await createOrder();
      const ack = await service.processNotification(signedNotification(order));
      expect(JSON.stringify(ack)).not.toContain(SERVER_KEY);

      const failure = service.processNotification(
        signedNotification(order, { signature_key: 'f'.repeat(128) }),
      );
      await failure.catch((error: Error) => {
        expect(JSON.stringify(error)).not.toContain(SERVER_KEY);
        expect(String(error)).not.toContain(SERVER_KEY);
      });
    });
  });
});
