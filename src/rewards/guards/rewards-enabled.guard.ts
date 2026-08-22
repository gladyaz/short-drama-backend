import { CanActivate, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';
import { RootConfig } from '../../config/configuration';

/**
 * Work unit "REWARDS BACKEND FOUNDATION": gates every `/rewards/*` route
 * behind `REWARDS_ENABLED=true`.
 *
 * Mirrors the `PaymentsService.assertPaymentsEnabled` posture — a feature
 * that ships dark refuses at the edge with 503 rather than being half-live.
 * Implemented as a GUARD rather than a per-method assertion because rewards
 * has several routes and a guard cannot be forgotten on a new one, whereas a
 * call at the top of each method can.
 *
 * 503 (not 404, not 403) is deliberate and matches `PAYMENTS_DISABLED`: the
 * route exists and the caller is allowed to use it, the capability is simply
 * not turned on in this deployment. A 404 would send clients hunting for a
 * different path; a 403 would suggest signing in differently might help.
 */
@Injectable()
export class RewardsEnabledGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<RootConfig>) {}

  canActivate(): boolean {
    const rewards = this.configService.get('rewards', { infer: true })!;

    if (!rewards.enabled) {
      throw new AppException(
        AppErrorCode.REWARDS_DISABLED,
        'Rewards are not enabled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return true;
  }
}
