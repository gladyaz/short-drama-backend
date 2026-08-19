import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PaymentOrder, Prisma } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { redactSensitiveText } from '../common/logging/redact';
import { PaymentsConfig, RootConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import {
  findPaymentPlan,
  PAYMENT_CHECKOUT_EXPIRY_MINUTES,
  PAYMENT_CHECKOUT_STUCK_CREATED_MS,
  PAYMENT_CURRENCY_IDR,
  PAYMENT_PROVIDER_MIDTRANS,
} from './payment-plan.constants';
import {
  OPEN_PAYMENT_ORDER_STATUSES,
  PaymentFailureCode,
  PaymentOrderStatus,
} from './payment-state.constants';
import {
  CheckoutResponseDto,
  PaymentOrderStatusDto,
  toCheckoutResponseDto,
  toPaymentOrderStatusDto,
} from './payment.types';
import { MIDTRANS_GATEWAY } from './midtrans/midtrans.types';
import type {
  MidtransGateway,
  MidtransSnapCheckout,
} from './midtrans/midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the authenticated
 * checkout/status side of the payment domain. (Webhook/reconciliation
 * processing lives in `PaymentNotificationService` — the two share the
 * state machine and the gateway port, not code paths.)
 *
 * CHECKOUT IDEMPOTENCY (`openOrderKey`): at most one OPEN
 * (CREATED/PENDING) order may exist per user+plan, enforced by the
 * nullable-unique `PaymentOrder.openOrderKey = "<userId>:<planId>"` column.
 * A retried/double-tapped checkout returns the EXISTING open order (no new
 * provider transaction, no second charge surface); a concurrent duplicate
 * INSERT loses with a unique violation and is answered from the winner's
 * row. Orders self-heal out of the slot in three bounded ways, all CAS
 * transitions that clear the key in the same write: provider create
 * failure (`FAILED`/`PROVIDER_CREATE_FAILED`), a crashed checkout older
 * than `PAYMENT_CHECKOUT_STUCK_CREATED_MS` (`FAILED`/`CHECKOUT_ABANDONED`),
 * and a payment window that elapsed without the provider's `expire`
 * notification (`EXPIRED`/`CHECKOUT_WINDOW_ELAPSED`).
 *
 * PRICING AUTHORITY: the client sends ONLY `planId`; amount, currency, and
 * entitlement duration are resolved here from `PAYMENT_PLANS` and snapshot
 * onto the order row. Nothing in this service reads an amount from a
 * request.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    @Inject(MIDTRANS_GATEWAY)
    private readonly midtransGateway: MidtransGateway,
  ) {}

  async createCheckout(
    userId: string,
    planId: string,
  ): Promise<CheckoutResponseDto> {
    this.assertPaymentsEnabled();

    const plan = findPaymentPlan(planId);
    if (!plan) {
      throw new AppException(
        AppErrorCode.PAYMENT_PLAN_NOT_FOUND,
        'Unknown payment plan',
        HttpStatus.NOT_FOUND,
      );
    }

    const openOrderKey = this.buildOpenOrderKey(userId, plan.id);

    const existing = await this.prisma.paymentOrder.findUnique({
      where: { openOrderKey },
    });
    if (existing) {
      const reusable = await this.resolveOpenOrder(existing);
      if (reusable) {
        this.logger.log(
          redactSensitiveText(
            `Checkout reused open payment order ${reusable.id} (plan ${plan.id})`,
          ),
        );
        return toCheckoutResponseDto(reusable);
      }
    }

    let order: PaymentOrder;
    try {
      order = await this.prisma.paymentOrder.create({
        data: {
          userId,
          provider: PAYMENT_PROVIDER_MIDTRANS,
          providerOrderId: this.generateProviderOrderId(),
          planId: plan.id,
          amountIdr: plan.priceIdr,
          currency: PAYMENT_CURRENCY_IDR,
          status: 'CREATED' satisfies PaymentOrderStatus,
          openOrderKey,
          entitlementDurationDays: plan.durationDays,
          checkoutExpiresAt: new Date(
            Date.now() + PAYMENT_CHECKOUT_EXPIRY_MINUTES * 60_000,
          ),
        },
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        // Lost the open-slot race to a concurrent request for the same
        // user+plan — answer from the winner's row instead of double
        // charging.
        const winner = await this.prisma.paymentOrder.findUnique({
          where: { openOrderKey },
        });
        if (winner) {
          const reusable = await this.resolveOpenOrder(winner);
          if (reusable) {
            return toCheckoutResponseDto(reusable);
          }
        }
        throw this.checkoutInProgress();
      }
      throw error;
    }

    let snap: MidtransSnapCheckout;
    try {
      snap = await this.midtransGateway.createSnapTransaction({
        orderId: order.providerOrderId,
        grossAmountIdr: order.amountIdr,
        expiryMinutes: PAYMENT_CHECKOUT_EXPIRY_MINUTES,
      });
    } catch (error) {
      // Fail the order (frees the open slot) BEFORE surfacing the error, so
      // a provider outage never strands a half-open order — and never
      // creates any Premium state.
      await this.prisma.paymentOrder.updateMany({
        where: {
          id: order.id,
          status: 'CREATED' satisfies PaymentOrderStatus,
        },
        data: {
          status: 'FAILED' satisfies PaymentOrderStatus,
          openOrderKey: null,
          failureCode: 'PROVIDER_CREATE_FAILED' satisfies PaymentFailureCode,
        },
      });
      this.logger.error(
        redactSensitiveText(
          `Midtrans Snap create failed for payment order ${order.id}: ${String(error)}`,
        ),
      );
      throw new AppException(
        AppErrorCode.PAYMENT_PROVIDER_ERROR,
        'Payment provider request failed',
        HttpStatus.BAD_GATEWAY,
      );
    }

    // CAS from CREATED only: if something already advanced this order, its
    // state is newer than ours — never overwrite it, just serve the fresh
    // row.
    const advanced = await this.prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'CREATED' satisfies PaymentOrderStatus },
      data: {
        status: 'PENDING' satisfies PaymentOrderStatus,
        snapToken: snap.token,
        checkoutUrl: snap.redirectUrl,
      },
    });

    const fresh = await this.prisma.paymentOrder.findUniqueOrThrow({
      where: { id: order.id },
    });

    if (advanced.count === 0) {
      this.logger.warn(
        redactSensitiveText(
          `Payment order ${order.id} advanced past CREATED before checkout finished (now ${fresh.status})`,
        ),
      );
    } else {
      this.logger.log(
        redactSensitiveText(
          `Payment order ${order.id} (${order.providerOrderId}) is PENDING for plan ${plan.id}`,
        ),
      );
    }

    return toCheckoutResponseDto(fresh);
  }

  /**
   * Owner-isolated order read. `orderRef` may be the internal id OR the
   * provider `order_id` (which is all a redirect-returned frontend has —
   * and querying THIS endpoint, never trusting the redirect itself, is the
   * mandated redirect-return flow). The `userId` predicate is part of the
   * query, so "exists but not yours" and "does not exist" are the same 404.
   */
  async getOrderForUser(
    userId: string,
    orderRef: string,
  ): Promise<PaymentOrderStatusDto> {
    this.assertPaymentsEnabled();

    const order = await this.prisma.paymentOrder.findFirst({
      where: {
        userId,
        OR: [{ id: orderRef }, { providerOrderId: orderRef }],
      },
    });

    if (!order) {
      throw new AppException(
        AppErrorCode.PAYMENT_ORDER_NOT_FOUND,
        'Payment order not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return toPaymentOrderStatusDto(order);
  }

  /**
   * Decides what an existing row occupying the open slot means for a new
   * checkout: reuse it, reclaim it (CAS it out of the slot and return
   * `null` so a fresh order is created), or report a genuinely in-flight
   * competitor (409).
   */
  private async resolveOpenOrder(
    existing: PaymentOrder,
  ): Promise<PaymentOrder | null> {
    const now = Date.now();

    if (
      !(OPEN_PAYMENT_ORDER_STATUSES as readonly string[]).includes(
        existing.status,
      )
    ) {
      // A terminal order still holding the slot should be impossible
      // (every terminal CAS clears the key) — heal it rather than wedging
      // this user+plan forever.
      await this.prisma.paymentOrder.updateMany({
        where: { id: existing.id, openOrderKey: existing.openOrderKey },
        data: { openOrderKey: null },
      });
      this.logger.warn(
        redactSensitiveText(
          `Cleared stale openOrderKey from terminal payment order ${existing.id} (${existing.status})`,
        ),
      );
      return null;
    }

    const windowElapsed =
      existing.checkoutExpiresAt !== null &&
      existing.checkoutExpiresAt.getTime() <= now;
    if (windowElapsed) {
      await this.prisma.paymentOrder.updateMany({
        where: {
          id: existing.id,
          status: { in: [...OPEN_PAYMENT_ORDER_STATUSES] },
        },
        data: {
          status: 'EXPIRED' satisfies PaymentOrderStatus,
          openOrderKey: null,
          failureCode: 'CHECKOUT_WINDOW_ELAPSED' satisfies PaymentFailureCode,
        },
      });
      return null;
    }

    if (
      existing.status === ('PENDING' satisfies PaymentOrderStatus) &&
      existing.checkoutUrl
    ) {
      return existing;
    }

    // CREATED (or a PENDING row missing its URL — a shape only a crash can
    // produce): reclaim once it is old enough that its provider call cannot
    // still be in flight; otherwise report the in-flight competitor.
    if (
      now - existing.createdAt.getTime() >=
      PAYMENT_CHECKOUT_STUCK_CREATED_MS
    ) {
      await this.prisma.paymentOrder.updateMany({
        where: {
          id: existing.id,
          status: { in: [...OPEN_PAYMENT_ORDER_STATUSES] },
        },
        data: {
          status: 'FAILED' satisfies PaymentOrderStatus,
          openOrderKey: null,
          failureCode: 'CHECKOUT_ABANDONED' satisfies PaymentFailureCode,
        },
      });
      this.logger.warn(
        redactSensitiveText(
          `Reclaimed abandoned payment order ${existing.id} (stuck in ${existing.status})`,
        ),
      );
      return null;
    }

    throw this.checkoutInProgress();
  }

  private assertPaymentsEnabled(): void {
    if (!this.paymentsConfig().enabled) {
      throw new AppException(
        AppErrorCode.PAYMENTS_DISABLED,
        'Payments are not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private paymentsConfig(): PaymentsConfig {
    return this.configService.get('payments', { infer: true })!;
  }

  private buildOpenOrderKey(userId: string, planId: string): string {
    return `${userId}:${planId}`;
  }

  /**
   * Server-generated Midtrans `order_id`: `sd-<uuidv4>` — 39 chars against
   * the verified String(50) limit, alphanumeric+dash against the verified
   * `-_~.` symbol allowlist, collision-safe by UUID, and NEVER influenced
   * by any client value.
   */
  private generateProviderOrderId(): string {
    return `sd-${randomUUID()}`;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private checkoutInProgress(): AppException {
    return new AppException(
      AppErrorCode.PAYMENT_CHECKOUT_IN_PROGRESS,
      'Another checkout for this plan is already in progress — retry in a moment',
      HttpStatus.CONFLICT,
    );
  }
}
