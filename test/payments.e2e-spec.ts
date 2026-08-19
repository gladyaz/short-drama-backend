import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AppExceptionFilter } from './../src/common/filters/app-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import type { AuthResponseDto } from './../src/auth/auth.types';
import type { EntitlementStatusDto } from './../src/entitlements/entitlement.types';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';
import { fixtureEmail } from './../src/common/testing/fixture-namespace.helpers';
import { resetThrottlerStorage } from './../src/common/testing/throttler-reset.helpers';
import { computeMidtransSignatureKey } from './../src/payments/midtrans/midtrans-signature.util';
import { MIDTRANS_GATEWAY } from './../src/payments/midtrans/midtrans.types';
import type { MidtransGateway } from './../src/payments/midtrans/midtrans.types';
import type {
  CheckoutResponseDto,
  PaymentOrderStatusDto,
} from './../src/payments/payment.types';

interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": e2e coverage over the
 * real HTTP layer against the real test database. The Midtrans gateway is
 * OVERRIDDEN at its DI token with an in-memory fake — NO test here (or in
 * any suite) makes a real Midtrans request, sandbox or production, and the
 * Server Key in play is a fixture string, not a credential.
 *
 * Two apps (the `entitlements.e2e-spec.ts` two-posture precedent):
 * `PAYMENTS_ENABLED` is read once at ConfigModule bootstrap, so the
 * default/production-safe posture (flag unset → 503s everywhere) and the
 * enabled posture compile separately.
 */
describe('Payments (e2e)', () => {
  const TEST_SERVER_KEY = 'SB-Mid-server-e2e-fixture-not-a-real-key';

  function signedNotification(
    providerOrderId: string,
    overrides: Partial<{
      status_code: string;
      gross_amount: string;
      transaction_status: string;
      fraud_status: string;
      signature_key: string;
    }> = {},
  ): Record<string, unknown> {
    const base = {
      order_id: providerOrderId,
      status_code: overrides.status_code ?? '200',
      gross_amount: overrides.gross_amount ?? '49000.00',
      transaction_status: overrides.transaction_status ?? 'settlement',
    };
    return {
      ...base,
      ...(overrides.fraud_status !== undefined
        ? { fraud_status: overrides.fraud_status }
        : {}),
      signature_key:
        overrides.signature_key ??
        computeMidtransSignatureKey({
          orderId: base.order_id,
          statusCode: base.status_code,
          grossAmount: base.gross_amount,
          serverKey: TEST_SERVER_KEY,
        }),
      unknown_future_field: 'tolerated',
    };
  }

  describe('with PAYMENTS_ENABLED unset (default, production-safe posture)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let accessToken: string;
    let userId: string;

    beforeAll(async () => {
      delete process.env.PAYMENTS_ENABLED;
      delete process.env.MIDTRANS_SERVER_KEY;
      delete process.env.MIDTRANS_IS_PRODUCTION;

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
        .send({
          email: fixtureEmail('payments-e2e-disabled'),
          password: 'correct-horse-battery',
        })
        .expect(HttpStatus.CREATED);
      const body = registerResponse.body as AuthResponseDto;
      accessToken = body.accessToken;
      userId = body.user.id;
    }, e2eSuiteBootBudgetMs(1));

    afterAll(async () => {
      await prisma.paymentOrder.deleteMany({ where: { userId } });
      await prisma.entitlement.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await app.close();
    });

    it('POST /payments/checkout answers 503 PAYMENTS_DISABLED', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ planId: 'premium-30d' })
        .expect(HttpStatus.SERVICE_UNAVAILABLE);
      expect((response.body as ErrorResponseBody).code).toBe(
        'PAYMENTS_DISABLED',
      );
    });

    it('the Midtrans webhook answers 503 PAYMENTS_DISABLED (retried by the provider, never lost)', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments/midtrans/notification')
        .send(signedNotification('sd-any'))
        .expect(HttpStatus.SERVICE_UNAVAILABLE);
      expect((response.body as ErrorResponseBody).code).toBe(
        'PAYMENTS_DISABLED',
      );
    });
  });

  describe('with PAYMENTS_ENABLED=true (gateway faked — no real provider call)', () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let throttlerStorage: ThrottlerStorageService;

    let tokenA: string;
    let userIdA: string;
    let tokenB: string;
    let userIdB: string;
    let tokenC: string;
    let userIdC: string;
    let tokenD: string;
    let userIdD: string;

    const snapCreateCalls: string[] = [];
    const fakeGateway: MidtransGateway = {
      createSnapTransaction: (input) => {
        snapCreateCalls.push(input.orderId);
        return Promise.resolve({
          token: `tok-${input.orderId}`,
          redirectUrl: `https://app.sandbox.midtrans.com/snap/v3/redirection/tok-${input.orderId}`,
        });
      },
      getTransactionStatus: () => Promise.resolve({ found: false }),
    };

    async function register(label: string): Promise<AuthResponseDto> {
      resetThrottlerStorage(throttlerStorage);
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: fixtureEmail(label),
          password: 'correct-horse-battery',
        })
        .expect(HttpStatus.CREATED);
      return response.body as AuthResponseDto;
    }

    async function checkout(
      token: string,
      planId: string,
    ): Promise<CheckoutResponseDto> {
      const response = await request(app.getHttpServer())
        .post('/payments/checkout')
        .set('Authorization', `Bearer ${token}`)
        .send({ planId })
        .expect(HttpStatus.CREATED);
      return response.body as CheckoutResponseDto;
    }

    async function postNotification(
      body: Record<string, unknown>,
      expectedStatus: HttpStatus,
    ): Promise<Record<string, unknown>> {
      const response = await request(app.getHttpServer())
        .post('/payments/midtrans/notification')
        .send(body)
        .expect(expectedStatus);
      return response.body as Record<string, unknown>;
    }

    async function getOrder(
      token: string,
      orderRef: string,
    ): Promise<PaymentOrderStatusDto> {
      const response = await request(app.getHttpServer())
        .get(`/payments/${orderRef}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(HttpStatus.OK);
      return response.body as PaymentOrderStatusDto;
    }

    beforeAll(async () => {
      process.env.PAYMENTS_ENABLED = 'true';
      process.env.MIDTRANS_SERVER_KEY = TEST_SERVER_KEY;
      delete process.env.MIDTRANS_IS_PRODUCTION;

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(MIDTRANS_GATEWAY)
        .useValue(fakeGateway)
        .compile();

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
      throttlerStorage =
        moduleFixture.get<ThrottlerStorageService>(getStorageToken());

      const a = await register('payments-e2e-a');
      tokenA = a.accessToken;
      userIdA = a.user.id;
      const b = await register('payments-e2e-b');
      tokenB = b.accessToken;
      userIdB = b.user.id;
      const c = await register('payments-e2e-c');
      tokenC = c.accessToken;
      userIdC = c.user.id;
      const d = await register('payments-e2e-d');
      tokenD = d.accessToken;
      userIdD = d.user.id;
    }, e2eSuiteBootBudgetMs(4));

    afterAll(async () => {
      const userIds = [userIdA, userIdB, userIdC, userIdD];
      await prisma.paymentOrder.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.entitlement.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await app.close();
      delete process.env.PAYMENTS_ENABLED;
      delete process.env.MIDTRANS_SERVER_KEY;
    });

    beforeEach(() => {
      resetThrottlerStorage(throttlerStorage);
    });

    describe('checkout', () => {
      it('rejects an unauthenticated checkout with 401', async () => {
        await request(app.getHttpServer())
          .post('/payments/checkout')
          .send({ planId: 'premium-30d' })
          .expect(HttpStatus.UNAUTHORIZED);
      });

      it('rejects an unknown plan with 404 PAYMENT_PLAN_NOT_FOUND', async () => {
        const response = await request(app.getHttpServer())
          .post('/payments/checkout')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({ planId: 'premium-lifetime' })
          .expect(HttpStatus.NOT_FOUND);
        expect((response.body as ErrorResponseBody).code).toBe(
          'PAYMENT_PLAN_NOT_FOUND',
        );
      });

      it('CRITICAL: prices come from the server catalog, retries are idempotent, and no response carries the Server Key', async () => {
        const first = await checkout(tokenA, 'premium-30d');

        expect(first.status).toBe('PENDING');
        expect(first.amountIdr).toBe(49000);
        expect(first.currency).toBe('IDR');
        expect(first.providerOrderId).toMatch(/^sd-/);
        expect(first.checkoutUrl).toContain('snap/v3/redirection');
        expect(JSON.stringify(first)).not.toContain(TEST_SERVER_KEY);

        const retried = await checkout(tokenA, 'premium-30d');
        expect(retried.orderId).toBe(first.orderId);
        expect(retried.providerOrderId).toBe(first.providerOrderId);

        const orders = await prisma.paymentOrder.findMany({
          where: { userId: userIdA, planId: 'premium-30d' },
        });
        expect(orders).toHaveLength(1);
      });
    });

    describe('order status — ownership isolation', () => {
      it('serves the owner by internal id and by provider order id; everyone else gets the same 404', async () => {
        const order = await checkout(tokenA, 'premium-30d');

        const byInternal = await getOrder(tokenA, order.orderId);
        expect(byInternal.isPaid).toBe(false);
        const byProvider = await getOrder(tokenA, order.providerOrderId);
        expect(byProvider.orderId).toBe(order.orderId);

        const foreign = await request(app.getHttpServer())
          .get(`/payments/${order.orderId}`)
          .set('Authorization', `Bearer ${tokenB}`)
          .expect(HttpStatus.NOT_FOUND);
        expect((foreign.body as ErrorResponseBody).code).toBe(
          'PAYMENT_ORDER_NOT_FOUND',
        );

        await request(app.getHttpServer())
          .get('/payments/sd-does-not-exist')
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(HttpStatus.NOT_FOUND);

        await request(app.getHttpServer())
          .get(`/payments/${order.orderId}`)
          .expect(HttpStatus.UNAUTHORIZED);
      });
    });

    describe('webhook — authenticity', () => {
      it('rejects a malformed body with 400 PAYMENT_NOTIFICATION_INVALID', async () => {
        const body = await postNotification(
          { order_id: 'sd-x' },
          HttpStatus.BAD_REQUEST,
        );
        expect(body.code).toBe('PAYMENT_NOTIFICATION_INVALID');
      });

      it('CRITICAL: rejects an invalid signature with 403 and changes nothing', async () => {
        const order = await checkout(tokenA, 'premium-30d');
        const body = await postNotification(
          signedNotification(order.providerOrderId, {
            signature_key: 'f'.repeat(128),
          }),
          HttpStatus.FORBIDDEN,
        );
        expect(body.code).toBe('PAYMENT_NOTIFICATION_REJECTED');

        const after = await getOrder(tokenA, order.orderId);
        expect(after.status).toBe('PENDING');
      });

      it('answers an unknown order with 404 PAYMENT_ORDER_NOT_FOUND', async () => {
        const body = await postNotification(
          signedNotification('sd-never-created-by-this-backend'),
          HttpStatus.NOT_FOUND,
        );
        expect(body.code).toBe('PAYMENT_ORDER_NOT_FOUND');
      });

      it('CRITICAL: rejects a signed-but-wrong-amount notification (tampered/spliced amount)', async () => {
        const order = await checkout(tokenB, 'premium-7d');
        const body = await postNotification(
          signedNotification(order.providerOrderId, { gross_amount: '1.00' }),
          HttpStatus.FORBIDDEN,
        );
        expect(body.code).toBe('PAYMENT_NOTIFICATION_REJECTED');

        const after = await getOrder(tokenB, order.orderId);
        expect(after.status).toBe('PENDING');
        expect(
          await prisma.entitlement.count({ where: { userId: userIdB } }),
        ).toBe(0);
      });
    });

    describe('webhook — success, idempotency, monotonicity (user A)', () => {
      it('CRITICAL: an authentic settlement pays the order and activates premium exactly once — duplicates and late pendings change nothing', async () => {
        const order = await checkout(tokenA, 'premium-30d');
        const settlement = signedNotification(order.providerOrderId);

        // Pending first (normal in-order flow) — no premium yet.
        await postNotification(
          signedNotification(order.providerOrderId, {
            transaction_status: 'pending',
            status_code: '201',
          }),
          HttpStatus.OK,
        );
        let entitlement = await request(app.getHttpServer())
          .get('/users/me/entitlement')
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(HttpStatus.OK);
        expect((entitlement.body as EntitlementStatusDto).isPremium).toBe(
          false,
        );

        // Authentic settlement — pays + grants.
        const ack = await postNotification(settlement, HttpStatus.OK);
        expect(ack).toEqual({ status: 'ok' });

        const paid = await getOrder(tokenA, order.orderId);
        expect(paid.status).toBe('PAID');
        expect(paid.isPaid).toBe(true);
        expect(paid.paidAt).not.toBeNull();

        entitlement = await request(app.getHttpServer())
          .get('/users/me/entitlement')
          .set('Authorization', `Bearer ${tokenA}`)
          .expect(HttpStatus.OK);
        expect((entitlement.body as EntitlementStatusDto).isPremium).toBe(true);

        const granted = await prisma.entitlement.findMany({
          where: { userId: userIdA },
        });
        expect(granted).toHaveLength(1);
        expect(granted[0].source).toBe('midtrans');

        // Duplicate settlement delivery — one grant, paidAt unmoved.
        await postNotification(settlement, HttpStatus.OK);
        const afterDuplicate = await getOrder(tokenA, order.orderId);
        expect(afterDuplicate.paidAt).toBe(paid.paidAt);
        expect(
          await prisma.entitlement.count({ where: { userId: userIdA } }),
        ).toBe(1);

        // Delayed out-of-order pending — never downgrades.
        await postNotification(
          signedNotification(order.providerOrderId, {
            transaction_status: 'pending',
            status_code: '201',
          }),
          HttpStatus.OK,
        );
        const afterLatePending = await getOrder(tokenA, order.orderId);
        expect(afterLatePending.status).toBe('PAID');
        expect(
          await prisma.entitlement.count({ where: { userId: userIdA } }),
        ).toBe(1);
      });
    });

    describe('webhook — failure and fraud outcomes (user B)', () => {
      it('deny marks the order FAILED and grants nothing', async () => {
        const order = await checkout(tokenB, 'premium-7d');
        await postNotification(
          signedNotification(order.providerOrderId, {
            transaction_status: 'deny',
            gross_amount: '19000.00',
          }),
          HttpStatus.OK,
        );
        const after = await getOrder(tokenB, order.orderId);
        expect(after.status).toBe('FAILED');
        expect(
          await prisma.entitlement.count({ where: { userId: userIdB } }),
        ).toBe(0);
      });

      it('cancel marks CANCELED; expire marks EXPIRED; neither grants', async () => {
        const cancelOrder = await checkout(tokenB, 'premium-7d');
        await postNotification(
          signedNotification(cancelOrder.providerOrderId, {
            transaction_status: 'cancel',
            gross_amount: '19000.00',
          }),
          HttpStatus.OK,
        );
        expect((await getOrder(tokenB, cancelOrder.orderId)).status).toBe(
          'CANCELED',
        );

        const expireOrder = await checkout(tokenB, 'premium-30d');
        await postNotification(
          signedNotification(expireOrder.providerOrderId, {
            transaction_status: 'expire',
          }),
          HttpStatus.OK,
        );
        expect((await getOrder(tokenB, expireOrder.orderId)).status).toBe(
          'EXPIRED',
        );

        expect(
          await prisma.entitlement.count({ where: { userId: userIdB } }),
        ).toBe(0);
      });

      it('CRITICAL: capture+challenge stays PENDING with no premium; the later capture+accept grants exactly once', async () => {
        const order = await checkout(tokenB, 'premium-90d');

        await postNotification(
          signedNotification(order.providerOrderId, {
            transaction_status: 'capture',
            fraud_status: 'challenge',
            gross_amount: '129000.00',
          }),
          HttpStatus.OK,
        );
        expect((await getOrder(tokenB, order.orderId)).status).toBe('PENDING');
        expect(
          await prisma.entitlement.count({ where: { userId: userIdB } }),
        ).toBe(0);

        await postNotification(
          signedNotification(order.providerOrderId, {
            transaction_status: 'capture',
            fraud_status: 'accept',
            gross_amount: '129000.00',
          }),
          HttpStatus.OK,
        );
        expect((await getOrder(tokenB, order.orderId)).status).toBe('PAID');
        expect(
          await prisma.entitlement.count({ where: { userId: userIdB } }),
        ).toBe(1);
      });
    });

    describe('entitlement stacking (user C)', () => {
      it('CRITICAL: two paid orders stack — the second expiry is exactly 30 days past the first', async () => {
        const week = await checkout(tokenC, 'premium-7d');
        await postNotification(
          signedNotification(week.providerOrderId, {
            gross_amount: '19000.00',
          }),
          HttpStatus.OK,
        );

        const month = await checkout(tokenC, 'premium-30d');
        await postNotification(
          signedNotification(month.providerOrderId),
          HttpStatus.OK,
        );

        const entitlements = await prisma.entitlement.findMany({
          where: { userId: userIdC },
          orderBy: { createdAt: 'asc' },
        });
        expect(entitlements).toHaveLength(2);
        expect(
          entitlements[1].expiresAt!.getTime() -
            entitlements[0].expiresAt!.getTime(),
        ).toBe(30 * 24 * 60 * 60 * 1000);

        const status = await request(app.getHttpServer())
          .get('/users/me/entitlement')
          .set('Authorization', `Bearer ${tokenC}`)
          .expect(HttpStatus.OK);
        expect((status.body as EntitlementStatusDto).isPremium).toBe(true);
        expect((status.body as EntitlementStatusDto).expiresAt).toBe(
          entitlements[1].expiresAt!.toISOString(),
        );
      });
    });

    describe('concurrency (user D)', () => {
      it('CRITICAL: simultaneous success delivery activates premium exactly once', async () => {
        const order = await checkout(tokenD, 'premium-30d');
        const settlement = signedNotification(order.providerOrderId);

        const server = app.getHttpServer();
        const [first, second] = await Promise.all([
          request(server)
            .post('/payments/midtrans/notification')
            .send(settlement),
          request(server)
            .post('/payments/midtrans/notification')
            .send(settlement),
        ]);
        expect(first.status).toBe(HttpStatus.OK);
        expect(second.status).toBe(HttpStatus.OK);

        expect((await getOrder(tokenD, order.orderId)).status).toBe('PAID');
        expect(
          await prisma.entitlement.count({ where: { userId: userIdD } }),
        ).toBe(1);
      });
    });
  });
});
