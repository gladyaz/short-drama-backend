import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';
import { DevToolsGuard } from './dev-tools.guard';

/**
 * Phase 10, work unit 10-B6. Verifies the dev-only entitlement grant/revoke
 * routes are unreachable unless `DEV_TOOLS_ENABLED=true`, per the security
 * requirement in the approved Phase 10 plan (§9/§11 decision 2).
 */
describe('DevToolsGuard', () => {
  function buildGuard(devToolsEnabled: boolean): DevToolsGuard {
    const configService = {
      get: () => ({ devToolsEnabled }),
    } as unknown as ConfigService<RootConfig>;
    return new DevToolsGuard(configService);
  }

  it('allows the request when devToolsEnabled is true', () => {
    const guard = buildGuard(true);
    expect(guard.canActivate()).toBe(true);
  });

  it('rejects the request with DEV_TOOLS_DISABLED when devToolsEnabled is false', () => {
    const guard = buildGuard(false);
    let thrown: unknown;
    try {
      guard.canActivate();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).code).toBe('DEV_TOOLS_DISABLED');
  });
});
