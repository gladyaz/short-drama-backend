import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

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
  providers: [AuthService],
})
export class AuthModule {}
