import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PAYMENT_WEBHOOK_RATE_LIMIT,
  PAYMENT_WEBHOOK_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { PaymentNotificationService } from './payment-notification.service';
import { PaymentWebhookAckDto } from './payment.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the PUBLIC provider
 * notification endpoint — a separate controller class from the
 * authenticated payment routes (the `SeriesPublicController` precedent), so
 * its auth posture is visible at the class level rather than buried per
 * route.
 *
 * DELIBERATELY NO `JwtAuthGuard`: Midtrans is not a user. Authenticity is
 * proven INSIDE the body by the SHA512 `signature_key`
 * (`PaymentNotificationService` verifies it before any state is read or
 * written) — provider authenticity and user authentication are different
 * mechanisms, and requiring a bearer token here would simply break real
 * deliveries while stopping no forger.
 *
 * `@Body() body: unknown` is deliberate: the global `ValidationPipe`
 * (whitelist + forbidNonWhitelisted) would REJECT any future extra field
 * Midtrans adds if this took a DTO class. The service narrows the payload
 * manually — required fields strictly, everything else tolerated.
 *
 * `@HttpCode(200)`: Midtrans treats any 2xx as delivered (no retry); the
 * Nest POST default of 201 would be wrong here semantically. Errors keep
 * their meaningful statuses (400 malformed, 403 rejected, 404 unknown
 * order, 503 disabled) — each maps onto Midtrans' documented bounded retry
 * ladder rather than silently swallowing a failure.
 */
@Controller('payments/midtrans')
export class PaymentsWebhookController {
  constructor(
    private readonly paymentNotificationService: PaymentNotificationService,
  ) {}

  @Post('notification')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: PAYMENT_WEBHOOK_RATE_LIMIT,
      ttl: PAYMENT_WEBHOOK_RATE_TTL_MS,
    },
  })
  handleNotification(@Body() body: unknown): Promise<PaymentWebhookAckDto> {
    return this.paymentNotificationService.processNotification(body);
  }
}
