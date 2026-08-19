import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentOrder } from '@prisma/client';
import { AppErrorCode } from '../common/errors/app-error-code';
import { AppException } from '../common/errors/app.exception';
import { redactSensitiveText } from '../common/logging/redact';
import { PaymentsConfig, RootConfig } from '../config/configuration';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_ENTITLEMENT_SOURCE_MIDTRANS } from './payment-plan.constants';
import {
  OPEN_PAYMENT_ORDER_STATUSES,
  PaymentOrderStatus,
  paymentOrderStatusesAllowingTransitionTo,
} from './payment-state.constants';
import {
  PaymentOrderStatusDto,
  PaymentWebhookAckDto,
  toPaymentOrderStatusDto,
} from './payment.types';
import { isValidMidtransSignatureKey } from './midtrans/midtrans-signature.util';
import { resolveMidtransTransactionStatus } from './midtrans/midtrans-status.util';
import { MIDTRANS_GATEWAY } from './midtrans/midtrans.types';
import type {
  MidtransGateway,
  MidtransTransactionFields,
  MidtransTransactionStatusResult,
} from './midtrans/midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": processes what the
 * PROVIDER says about an order — webhook notifications and GET Status
 * reconciliation reads — and is the only code that can move an order to
 * `PAID` or grant payment premium.
 *
 * AUTHENTICITY ORDER OF OPERATIONS (webhook): shape → signature → order
 * lookup → amount-vs-order → state resolution. The signature
 * (`SHA512(order_id + status_code + gross_amount + ServerKey)`, verified
 * official formula, timing-safe compare) is checked BEFORE any database
 * work, so forged traffic costs one hash, not a query. The amount check
 * then pins the signature-covered `gross_amount` to the ORDER'S OWN
 * server-computed `amountIdr` — a valid-signature notification for the
 * right order but the wrong amount (e.g. an order-id/amount splice) is
 * rejected, not processed.
 *
 * IDEMPOTENCY / OUT-OF-ORDER / RACES: every transition is a guarded
 * `updateMany` CAS derived from the state machine
 * (`payment-state.constants.ts`), so duplicates and regressions match 0
 * rows and write nothing. The PAID path runs its CAS inside a
 * `$transaction` together with the entitlement grant: under simultaneous
 * duplicate success delivery, Postgres row-locks the order for the first
 * writer, the second re-evaluates the WHERE after commit, matches 0 rows,
 * and skips the grant — at-most-one entitlement per order is a database
 * guarantee, reinforced by the `entitlementId` unique column written in
 * the same transaction. No raw notification payload is ever persisted
 * (deliberate: normalized identifier/status fields only — bounded, and no
 * `signature_key` can leak through storage, API, or logs).
 *
 * The provider ACK (`{ status: 'ok' }`) is returned for processed AND
 * deliberately-ignored notifications (unknown future statuses, regressive
 * duplicates) — per Midtrans retry semantics a 2xx stops redelivery, which
 * is exactly right once we have durably decided the notification changes
 * nothing.
 */
@Injectable()
export class PaymentNotificationService {
  private readonly logger = new Logger(PaymentNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    @Inject(MIDTRANS_GATEWAY)
    private readonly midtransGateway: MidtransGateway,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  async processNotification(body: unknown): Promise<PaymentWebhookAckDto> {
    const payments = this.paymentsConfig();
    if (!payments.enabled || !payments.midtransServerKey) {
      throw new AppException(
        AppErrorCode.PAYMENTS_DISABLED,
        'Payments are not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const notification = this.parseNotification(body);

    const isAuthentic = isValidMidtransSignatureKey({
      orderId: notification.orderId,
      statusCode: notification.statusCode,
      grossAmount: notification.grossAmount,
      serverKey: payments.midtransServerKey,
      signatureKey: notification.signatureKey,
    });
    if (!isAuthentic) {
      this.logger.warn(
        redactSensitiveText(
          `Rejected Midtrans notification with an invalid signature (order_id ${notification.orderId})`,
        ),
      );
      throw this.notificationRejected();
    }

    const order = await this.prisma.paymentOrder.findUnique({
      where: { providerOrderId: notification.orderId },
    });
    if (!order) {
      this.logger.warn(
        redactSensitiveText(
          `Midtrans notification for unknown order_id ${notification.orderId} — not ours, answering 404`,
        ),
      );
      throw new AppException(
        AppErrorCode.PAYMENT_ORDER_NOT_FOUND,
        'Payment order not found',
        HttpStatus.NOT_FOUND,
      );
    }

    if (!this.grossAmountMatchesOrder(notification.grossAmount, order)) {
      this.logger.error(
        redactSensitiveText(
          `Rejected Midtrans notification for order ${order.id}: gross_amount does not match the order's authoritative amount`,
        ),
      );
      throw this.notificationRejected();
    }

    await this.applyProviderOutcome(order, {
      transactionStatus: notification.transactionStatus,
      statusCode: notification.statusCode,
      fraudStatus: notification.fraudStatus,
      transactionId: notification.transactionId,
    });

    return { status: 'ok' };
  }

  /**
   * Reconciliation/failover per the official guidance ("You should call GET
   * Status API to get the latest/actual status"): re-reads the transaction
   * DIRECTLY from Midtrans over authenticated TLS (its own authenticity —
   * no signature math needed) and applies the same resolution/transition
   * logic as the webhook. Service-level support only — nothing in this
   * slice polls it; a future ops surface or a stuck-order janitor calls it
   * deliberately, per order.
   */
  async reconcilePayment(orderRef: string): Promise<PaymentOrderStatusDto> {
    const payments = this.paymentsConfig();
    if (!payments.enabled) {
      throw new AppException(
        AppErrorCode.PAYMENTS_DISABLED,
        'Payments are not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const order = await this.prisma.paymentOrder.findFirst({
      where: { OR: [{ id: orderRef }, { providerOrderId: orderRef }] },
    });
    if (!order) {
      throw new AppException(
        AppErrorCode.PAYMENT_ORDER_NOT_FOUND,
        'Payment order not found',
        HttpStatus.NOT_FOUND,
      );
    }

    let providerStatus: MidtransTransactionStatusResult;
    try {
      providerStatus = await this.midtransGateway.getTransactionStatus(
        order.providerOrderId,
      );
    } catch (error) {
      this.logger.error(
        redactSensitiveText(
          `Midtrans status fetch failed while reconciling order ${order.id}: ${String(error)}`,
        ),
      );
      throw new AppException(
        AppErrorCode.PAYMENT_PROVIDER_ERROR,
        'Payment provider request failed',
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (!providerStatus.found) {
      // Normal for a Snap order the customer never started paying —
      // nothing to reconcile against; the local state stands.
      this.logger.log(
        redactSensitiveText(
          `Reconcile: Midtrans does not know order ${order.id} yet — local status ${order.status} stands`,
        ),
      );
      return toPaymentOrderStatusDto(order);
    }

    if (
      providerStatus.grossAmount !== undefined &&
      !this.grossAmountMatchesOrder(providerStatus.grossAmount, order)
    ) {
      // The provider's own authoritative read disagreeing with our stored
      // amount can only mean local corruption or a mis-created provider
      // transaction — surface loudly, transition nothing.
      this.logger.error(
        redactSensitiveText(
          `Reconcile: provider gross_amount does not match order ${order.id}'s authoritative amount — refusing to apply`,
        ),
      );
      return toPaymentOrderStatusDto(order);
    }

    await this.applyProviderOutcome(order, {
      transactionStatus: providerStatus.transactionStatus,
      statusCode: providerStatus.statusCode,
      fraudStatus: providerStatus.fraudStatus,
      transactionId: providerStatus.transactionId,
    });

    const fresh = await this.prisma.paymentOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    return toPaymentOrderStatusDto(fresh);
  }

  /**
   * Shared by webhook + reconcile: normalize the provider outcome and apply
   * it as a state-machine-derived CAS.
   */
  private async applyProviderOutcome(
    order: PaymentOrder,
    fields: MidtransTransactionFields,
  ): Promise<void> {
    const resolution = resolveMidtransTransactionStatus(fields);

    if (resolution.kind === 'ignored') {
      this.logger.warn(
        redactSensitiveText(
          `Ignored Midtrans outcome for order ${order.id} (${resolution.reason}; transaction_status ${fields.transactionStatus})`,
        ),
      );
      return;
    }

    if (resolution.target === 'PAID') {
      await this.applyPaidTransition(order, fields);
      return;
    }

    const target = resolution.target;
    const clearsOpenSlot = !(
      OPEN_PAYMENT_ORDER_STATUSES as readonly string[]
    ).includes(target);

    const result = await this.prisma.paymentOrder.updateMany({
      where: {
        id: order.id,
        status: { in: [...paymentOrderStatusesAllowingTransitionTo(target)] },
      },
      data: {
        status: target,
        providerTransactionStatus: fields.transactionStatus,
        providerFraudStatus: fields.fraudStatus ?? null,
        providerTransactionId:
          fields.transactionId ?? order.providerTransactionId,
        ...(clearsOpenSlot ? { openOrderKey: null } : {}),
      },
    });

    if (result.count === 0) {
      this.logger.log(
        redactSensitiveText(
          `Skipped out-of-order/duplicate Midtrans outcome for order ${order.id} (${order.status} does not admit ${target})`,
        ),
      );
      return;
    }

    this.logger.log(
      redactSensitiveText(
        `Payment order ${order.id} transitioned ${order.status} -> ${target} (provider status ${fields.transactionStatus})`,
      ),
    );
  }

  /**
   * The authoritative success path. One `$transaction`:
   *   1. Lock the owning `User` row FIRST (`FOR UPDATE`) — see below.
   *   2. CAS the order into PAID from exactly the states the machine
   *      admits (never from PAID itself — that is what makes a duplicate
   *      success a 0-row no-op and the entitlement grant at-most-once).
   *   3. Grant/extend premium via `EntitlementsService.grantPaidPremium`
   *      (which re-takes the same, already-held User lock — a no-op — and
   *      serializes per-user expiry stacking).
   *   4. Record the grant on the order (`entitlementId`, unique).
   * A rollback anywhere rolls back ALL of it — no PAID order without its
   * grant decision, no grant without its PAID order.
   *
   * WHY THE USER LOCK COMES FIRST (Reviewer B fix cycle 1, HIGH): this
   * transaction touches two lockable resources — the `PaymentOrder` row and
   * the `User` row — and `AuthService`'s CANONICAL AUTH LOCK ORDER
   * (`auth.service.ts`) locks `User` FIRST in every multi-statement
   * transaction; `deleteAccount` in particular holds the `User` lock and
   * then, via `PaymentOrder.userId`'s `SetNull` FK action inside
   * `DELETE FROM "User"`, needs a lock on this very order row. Locking
   * order-then-user here would form exactly the lock-order cycle
   * (`40P01` deadlock) the auth-lock-order hardening slice eliminated for
   * every other table. Taking the `User` lock first restores a single
   * global order (User → dependent rows) across both modules. An order
   * whose `userId` is already `NULL` (or whose user row vanished — the
   * lock SELECT simply returns no row) skips the lock: the transaction
   * then only ever locks the single order row, which cannot cycle.
   */
  private async applyPaidTransition(
    order: PaymentOrder,
    fields: MidtransTransactionFields,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (order.userId) {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${order.userId} FOR UPDATE`;
      }

      const claimed = await tx.paymentOrder.updateMany({
        where: {
          id: order.id,
          status: {
            in: [...paymentOrderStatusesAllowingTransitionTo('PAID')],
          },
        },
        data: {
          status: 'PAID' satisfies PaymentOrderStatus,
          paidAt: new Date(),
          openOrderKey: null,
          failureCode: null,
          providerTransactionStatus: fields.transactionStatus,
          providerFraudStatus: fields.fraudStatus ?? null,
          providerTransactionId:
            fields.transactionId ?? order.providerTransactionId,
        },
      });

      if (claimed.count === 0) {
        this.logger.log(
          redactSensitiveText(
            `Duplicate/out-of-order success for order ${order.id} ignored — already settled`,
          ),
        );
        return;
      }

      if (!order.userId) {
        this.logger.warn(
          redactSensitiveText(
            `Payment order ${order.id} is PAID but its user was deleted — payment recorded, no entitlement granted`,
          ),
        );
        return;
      }

      const granted = await this.entitlementsService.grantPaidPremium(
        tx,
        order.userId,
        order.entitlementDurationDays,
        PAYMENT_ENTITLEMENT_SOURCE_MIDTRANS,
      );

      if (!granted) {
        this.logger.warn(
          redactSensitiveText(
            `Payment order ${order.id} is PAID but its user row vanished mid-grant — payment recorded, no entitlement granted`,
          ),
        );
        return;
      }

      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { entitlementId: granted.id },
      });

      this.logger.log(
        redactSensitiveText(
          `Payment order ${order.id} PAID — premium extended to ${granted.expiresAt.toISOString()} (entitlement ${granted.id})`,
        ),
      );
    });
  }

  /**
   * Manual, tolerant narrowing (NOT a whitelisting DTO): the five
   * signature-relevant fields must be present strings; `fraud_status` and
   * `transaction_id` are optional strings; every OTHER field the provider
   * sends now or in the future is ignored, never rejected. Field lengths
   * are sanity-bounded so a hostile payload cannot park kilobytes in logs
   * or hashes.
   */
  private parseNotification(body: unknown): {
    orderId: string;
    statusCode: string;
    grossAmount: string;
    signatureKey: string;
    transactionStatus: string;
    fraudStatus?: string;
    transactionId?: string;
  } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw this.notificationInvalid();
    }

    const record = body as Record<string, unknown>;
    const requiredField = (key: string): string => {
      const value = record[key];
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 512
      ) {
        throw this.notificationInvalid();
      }
      return value;
    };
    const optionalField = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === 'string' && value.length <= 512
        ? value
        : undefined;
    };

    return {
      orderId: requiredField('order_id'),
      statusCode: requiredField('status_code'),
      grossAmount: requiredField('gross_amount'),
      signatureKey: requiredField('signature_key'),
      transactionStatus: requiredField('transaction_status'),
      fraudStatus: optionalField('fraud_status'),
      transactionId: optionalField('transaction_id'),
    };
  }

  /**
   * Midtrans serializes amounts as decimal strings (`"49000.00"`); the
   * order stores whole IDR. Numeric equality against the order's own
   * amount — never a client value, never a tolerance.
   */
  private grossAmountMatchesOrder(
    grossAmount: string,
    order: PaymentOrder,
  ): boolean {
    const parsed = Number(grossAmount);
    return Number.isFinite(parsed) && parsed === order.amountIdr;
  }

  private paymentsConfig(): PaymentsConfig {
    return this.configService.get('payments', { infer: true })!;
  }

  private notificationInvalid(): AppException {
    return new AppException(
      AppErrorCode.PAYMENT_NOTIFICATION_INVALID,
      'Notification payload is malformed',
      HttpStatus.BAD_REQUEST,
    );
  }

  private notificationRejected(): AppException {
    return new AppException(
      AppErrorCode.PAYMENT_NOTIFICATION_REJECTED,
      'Notification rejected',
      HttpStatus.FORBIDDEN,
    );
  }
}
