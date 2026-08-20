import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RootConfig } from '../config/configuration';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthIdentityController } from './identity/auth-identity.controller';
import { AuthIdentityService } from './identity/auth-identity.service';
import { DisabledGoogleIdentityVerifier } from './identity/google/google-disabled.verifier';
import {
  GOOGLE_IDENTITY_VERIFIER,
  GoogleIdentityVerifier,
} from './identity/google/google-identity.types';
import { GoogleOidcIdentityVerifier } from './identity/google/google-oidc.verifier';
import { DisabledWhatsAppOtpProvider } from './identity/whatsapp/whatsapp-disabled.provider';
import {
  isFakeWhatsAppProviderAllowed,
  LocalFakeWhatsAppOtpProvider,
} from './identity/whatsapp/whatsapp-local-fake.provider';
import { WhatsAppOtpService } from './identity/whatsapp/whatsapp-otp.service';
import {
  WHATSAPP_OTP_PROVIDER,
  WhatsAppOtpProvider,
} from './identity/whatsapp/whatsapp-otp.types';

/**
 * `JwtModule.register({})` is intentionally configured with no default
 * secret/options here: the access token's secret and expiry are supplied
 * per-call in `AuthService.issueTokensAndSession` (sourced from
 * `ConfigService` / `JWT_ACCESS_SECRET`), not as module-wide defaults. This
 * keeps the signing secret out of any static module configuration and
 * sourced from validated env config at the point of use.
 *
 * PHASE 10B — PRODUCTION IDENTITY PROVIDERS. The two provider bindings below
 * mirror `PaymentsModule`'s `MIDTRANS_GATEWAY` factory exactly: the REAL
 * implementation exists ONLY when its feature flag is on AND its required
 * configuration is present; in every other posture — including this
 * repository's shipped default — the token resolves to an inert
 * `Disabled*` implementation that holds no configuration and can reach no
 * network. Both tokens are overridable in tests via
 * `.overrideProvider(...)`, so no test suite can make a real request to
 * Google or to a messaging vendor.
 */
@Module({
  imports: [JwtModule.register({})],
  // Phase 12, work unit 12C-B1: `AccountDeletionController` hosts `POST
  // /users/me/deletion` — a separate controller class purely because
  // `AuthController` carries a fixed `@Controller('auth')` prefix that
  // cannot host a bare `/users/me/deletion` route (see that controller's
  // own doc comment).
  //
  // Phase 10B: `AuthIdentityController` DOES share the `auth` prefix, and is
  // split out for the opposite reason — not routing, but size and cohesion
  // (`common/coding-style.md`: many small, focused files). It follows the
  // same "one controller class per route family, all delegating to a
  // service" shape as the other two.
  controllers: [
    AuthController,
    AccountDeletionController,
    AuthIdentityController,
  ],
  providers: [
    AuthService,
    JwtAuthGuard,
    AccountLockoutService,
    AuthAuditService,
    AuthIdentityService,
    WhatsAppOtpService,
    {
      provide: GOOGLE_IDENTITY_VERIFIER,
      useFactory: (
        configService: ConfigService<RootConfig>,
      ): GoogleIdentityVerifier => {
        const identity = configService.get('identityProviders', {
          infer: true,
        })!;

        // BOTH conditions are required, not just the flag: a verifier with
        // no audience allowlist can accept nothing (see
        // `validateGoogleClaims`) and its own constructor refuses to be
        // built in that state. `env.validation.ts` already fails the boot
        // for that combination, so this is the second of two independent
        // guards rather than the only one.
        if (identity.googleEnabled && identity.googleClientIds.length > 0) {
          return new GoogleOidcIdentityVerifier({
            allowedAudiences: identity.googleClientIds,
          });
        }
        return new DisabledGoogleIdentityVerifier();
      },
      inject: [ConfigService],
    },
    {
      provide: WHATSAPP_OTP_PROVIDER,
      useFactory: (
        configService: ConfigService<RootConfig>,
      ): WhatsAppOtpProvider => {
        const identity = configService.get('identityProviders', {
          infer: true,
        })!;

        // THREE conditions, all required, and the `NODE_ENV` allowlist is
        // repeated here even though `env.validation.ts` already enforces it
        // at boot. That duplication is deliberate: this factory is the last
        // point before a provider that retains PLAINTEXT OTP CODES IN MEMORY
        // is constructed, and a fail-closed check at the point of
        // construction cannot be bypassed by a code path that skipped
        // validation (a test harness building the module directly, a future
        // refactor of `validateEnv`). `LocalFakeWhatsAppOtpProvider`'s own
        // constructor then refuses a third time. See that class's doc
        // comment for all four gates.
        //
        // There is deliberately NO real-vendor branch: no WhatsApp vendor
        // client ships in this build, because no vendor credentials exist to
        // build or test one against. `env.validation.ts` refuses to boot
        // with `WHATSAPP_AUTH_ENABLED=true` and any driver other than
        // `fake`, so this factory can never silently fall back to an inert
        // provider on a server that believes WhatsApp sign-in is enabled.
        if (
          identity.whatsappEnabled &&
          identity.whatsappOtpDriver === 'fake' &&
          isFakeWhatsAppProviderAllowed(process.env.NODE_ENV)
        ) {
          return new LocalFakeWhatsAppOtpProvider(process.env.NODE_ENV);
        }
        return new DisabledWhatsAppOtpProvider();
      },
      inject: [ConfigService],
    },
  ],
  // `JwtModule` is re-exported alongside `JwtAuthGuard` so that any module
  // importing `AuthModule` purely to reuse `JwtAuthGuard` (e.g. Phase 9's
  // `InteractionsModule`/`ProgressModule`) also has `JwtService` available
  // in its own container — otherwise Nest cannot resolve `JwtAuthGuard`'s
  // constructor dependency when the guard is referenced by class in a
  // different module's `@UseGuards()`.
  //
  // `AuthAuditService` is exported (Phase 12, work unit 12A-B3) since later
  // Phase 12 units in the same DAG (12A-B4's redaction-leak verification,
  // 12B-B1's change-password, 12C-B1's account deletion, ...) are already
  // documented as depending on this exact audit-emission path being
  // reusable outside `AuthModule` itself, not just internal to it.
  //
  // Phase 10B: `WhatsAppOtpService` is exported so an e2e suite can reach
  // its `localFakeProvider` accessor to read back the code that "was sent",
  // exercising the same "the user read the message" step a real client
  // performs instead of reaching into the database. Nothing in production
  // code imports it from outside this module.
  exports: [JwtAuthGuard, JwtModule, AuthAuditService, WhatsAppOtpService],
})
export class AuthModule {}
