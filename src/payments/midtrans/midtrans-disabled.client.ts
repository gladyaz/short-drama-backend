import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import {
  MidtransGateway,
  MidtransSnapCheckout,
  MidtransTransactionStatusResult,
} from './midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the inert gateway bound
 * to `MIDTRANS_GATEWAY` whenever `PAYMENTS_ENABLED` is not `"true"` (this
 * repo's shipped default) — the `NoopTranscodeQueueClient` pattern applied
 * to the payment provider. It makes NO network call, holds NO credential,
 * and rejects every invocation with the same `PAYMENTS_DISABLED` (503) the
 * services themselves answer, purely as defense-in-depth: `PaymentsService`
 * and `PaymentNotificationService` each check the flag BEFORE calling the
 * gateway, so reaching one of these rejections means a flag check was
 * bypassed — failing closed here keeps even that hypothetical path from
 * touching a provider.
 */
export class DisabledMidtransGateway implements MidtransGateway {
  createSnapTransaction(): Promise<MidtransSnapCheckout> {
    return Promise.reject(this.disabled());
  }

  getTransactionStatus(): Promise<MidtransTransactionStatusResult> {
    return Promise.reject(this.disabled());
  }

  private disabled(): AppException {
    return new AppException(
      AppErrorCode.PAYMENTS_DISABLED,
      'Payments are not enabled on this server',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
