import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { RootConfig } from '../config/configuration';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { PaymentNotificationService } from './payment-notification.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { DisabledMidtransGateway } from './midtrans/midtrans-disabled.client';
import { HttpMidtransClient } from './midtrans/midtrans-http.client';
import { MIDTRANS_GATEWAY, MidtransGateway } from './midtrans/midtrans.types';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION". Imports `AuthModule`
 * directly for `JwtAuthGuard` (the house convention — never a transitive
 * re-export) and `EntitlementsModule` for `EntitlementsService`, the only
 * path by which a payment can grant premium.
 *
 * The `MIDTRANS_GATEWAY` binding mirrors `TranscodeModule`'s flag-gated
 * real-vs-inert factory exactly: the real `HttpMidtransClient` (which is
 * what holds the Server Key, prebuilt into a Basic-auth header) exists ONLY
 * when `PAYMENTS_ENABLED=true` AND the key is configured; in every other
 * posture — including this repo's shipped default — the token resolves to
 * `DisabledMidtransGateway`, which holds no credential and can reach no
 * network. E2E suites override this token with an in-memory fake, so the
 * normal test suites can never make a real Midtrans request regardless of
 * environment.
 */
@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [PaymentsController, PaymentsWebhookController],
  providers: [
    PaymentsService,
    PaymentNotificationService,
    {
      provide: MIDTRANS_GATEWAY,
      useFactory: (
        configService: ConfigService<RootConfig>,
      ): MidtransGateway => {
        const payments = configService.get('payments', { infer: true })!;
        if (payments.enabled && payments.midtransServerKey) {
          return new HttpMidtransClient({
            serverKey: payments.midtransServerKey,
            isProduction: payments.midtransIsProduction,
          });
        }
        return new DisabledMidtransGateway();
      },
      inject: [ConfigService],
    },
  ],
})
export class PaymentsModule {}
