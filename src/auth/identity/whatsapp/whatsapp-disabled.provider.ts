import { HttpStatus } from '@nestjs/common';
import { AppErrorCode } from '../../../common/errors/app-error-code';
import { AppException } from '../../../common/errors/app.exception';
import { WhatsAppOtpProvider } from './whatsapp-otp.types';

/**
 * PHASE 10B — the inert provider bound to `WHATSAPP_OTP_PROVIDER` whenever
 * `WHATSAPP_AUTH_ENABLED` is not `"true"` (this repository's shipped
 * default). Same `DisabledMidtransGateway` shape and same defense-in-depth
 * rationale as `DisabledGoogleIdentityVerifier`: `AuthIdentityService`
 * checks the flag first, so a rejection from here means a flag check was
 * bypassed, and failing closed keeps even that path from pretending a
 * message was sent.
 */
export class DisabledWhatsAppOtpProvider implements WhatsAppOtpProvider {
  sendOtp(): Promise<void> {
    return Promise.reject(
      new AppException(
        AppErrorCode.WHATSAPP_AUTH_DISABLED,
        'WhatsApp sign-in is not enabled on this server',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
  }
}
