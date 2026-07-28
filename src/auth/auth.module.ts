import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccountLockoutService } from './account-lockout.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * `JwtModule.register({})` is intentionally configured with no default
 * secret/options here: the access token's secret and expiry are supplied
 * per-call in `AuthService.issueTokensAndSession` (sourced from
 * `ConfigService` / `JWT_ACCESS_SECRET`), not as module-wide defaults. This
 * keeps the signing secret out of any static module configuration and
 * sourced from validated env config at the point of use.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    AccountLockoutService,
    AuthAuditService,
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
  exports: [JwtAuthGuard, JwtModule, AuthAuditService],
})
export class AuthModule {}
