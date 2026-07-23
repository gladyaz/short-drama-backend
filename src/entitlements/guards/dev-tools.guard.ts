import { CanActivate, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../../config/configuration';
import { AppErrorCode } from '../../common/errors/app-error-code';
import { AppException } from '../../common/errors/app.exception';

/**
 * Phase 10, work unit 10-B5: gates the dev-only entitlement grant/revoke
 * routes behind `DEV_TOOLS_ENABLED=true`. `env.validation.ts` already
 * refuses to boot the app at all if this flag is combined with
 * `NODE_ENV=production`, so this guard's only job at request time is
 * rejecting the route when the flag is simply off (the expected state for
 * any environment that isn't a developer's own machine).
 */
@Injectable()
export class DevToolsGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<RootConfig>) {}

  canActivate(): boolean {
    const appConfig = this.configService.get('app', { infer: true })!;

    if (!appConfig.devToolsEnabled) {
      throw new AppException(
        AppErrorCode.DEV_TOOLS_DISABLED,
        'Dev-only entitlement tools are disabled',
        HttpStatus.NOT_FOUND,
      );
    }

    return true;
  }
}
