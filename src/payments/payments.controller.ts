import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import {
  PAYMENT_CHECKOUT_RATE_LIMIT,
  PAYMENT_CHECKOUT_RATE_TTL_MS,
} from '../common/rate-limit.constants';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PaymentsService } from './payments.service';
import { CheckoutResponseDto, PaymentOrderStatusDto } from './payment.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the AUTHENTICATED
 * payment surface. (The provider webhook lives on a separate, deliberately
 * unauthenticated controller — `payments-webhook.controller.ts` — matching
 * the `SeriesPublicController` "separate controller class per auth
 * posture" precedent.)
 *
 * REDIRECT-RETURN POLICY (binding for every future frontend): when the
 * customer lands back from the hosted Midtrans page, the query parameters
 * Midtrans appends (`order_id`, `status_code`, `transaction_status`) are
 * UI hints only. The frontend flow is: show "checking payment" →
 * `GET /payments/:orderId` (the `order_id` from the redirect is accepted
 * as the ref) → render what THIS backend says. Nothing in this module —
 * and nothing that may ever be added to it — mutates entitlement or order
 * state from redirect parameters; only the signature-verified webhook and
 * the authenticated GET Status reconciliation can move an order.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  @Throttle({
    default: {
      limit: PAYMENT_CHECKOUT_RATE_LIMIT,
      ttl: PAYMENT_CHECKOUT_RATE_TTL_MS,
    },
  })
  createCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    return this.paymentsService.createCheckout(user.id, dto.planId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':orderId')
  getOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ): Promise<PaymentOrderStatusDto> {
    return this.paymentsService.getOrderForUser(user.id, orderId);
  }
}
