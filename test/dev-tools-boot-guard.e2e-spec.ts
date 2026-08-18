// Phase 12, work unit 12D-B2: `ConfigModule.forRoot`'s `validate: validateEnv`
// option (see `src/app.module.ts`) invokes `validateEnv` SYNCHRONOUSLY, once,
// as part of `AppModule`'s `@Module()` decorator evaluation. Jest gives each
// test FILE its own isolated module registry, so that decorator evaluation
// happens exactly once per file — the first time THIS file's
// `import { AppModule } from './../src/app.module'` statement (below) runs.
// That means the misconfiguration this file proves closed
// (`DEV_TOOLS_ENABLED=true` + an unset `NODE_ENV`) MUST already be in place
// BEFORE that import executes: mutating `process.env` inside a
// `beforeAll`/`it` block — the way every other `*.e2e-spec.ts` file in this
// repo toggles `DEV_TOOLS_ENABLED` — is too late here, because `AppModule`
// (and therefore `validateEnv`) would already have run against whatever
// `process.env` looked like when this file started loading, before any test
// body gets a chance to mutate it. Hence this file is deliberately
// standalone (it does not reuse `admin.e2e-spec.ts`/
// `entitlements.e2e-spec.ts`, which already import `AppModule` for other
// purposes before any test in those files runs) and mutates `process.env`
// as its very first statements, ahead of any `import`.
const originalDevToolsEnabled = process.env.DEV_TOOLS_ENABLED;
const originalNodeEnv = process.env.NODE_ENV;

process.env.DEV_TOOLS_ENABLED = 'true';
delete process.env.NODE_ENV;

import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { e2eSuiteBootBudgetMs } from './../src/common/testing/e2e-boot-budget.helpers';

/**
 * Proves the privilege-escalation path the 12D-B2 fix closes is actually
 * closed at the full application-boot level — not merely that
 * `validateEnv` throws in isolation (already covered exhaustively by the
 * matrix in `src/config/env.validation.spec.ts`). `DevToolsGuard` gates BOTH
 * `/dev/admin/*` (`AdminController`'s self-service admin-role grant/revoke —
 * the privilege-escalation surface the 12D-B2 review escalated this finding
 * over) and `/dev/entitlements/*` (`EntitlementsController`) behind the same
 * `DEV_TOOLS_ENABLED` flag, but the flag is validated once, at the
 * WHOLE-APPLICATION boot level, by `ConfigModule.forRoot`'s `validate`. So a
 * single failed `AppModule` compile proves BOTH route groups unreachable at
 * once: if `Test.createTestingModule({ imports: [AppModule] }).compile()`
 * (mirroring exactly what every other `*.e2e-spec.ts` file in this repo does
 * to stand up its app) rejects, `app.init()`/`app.listen()` never run, no
 * `INestApplication` instance and no HTTP server of any kind exist, and
 * therefore literally no route — dev-only or otherwise — can be reached.
 */
describe('AppModule boot guard — DEV_TOOLS_ENABLED=true with a misconfigured NODE_ENV (Phase 12, 12D-B2)', () => {
  afterAll(() => {
    if (originalDevToolsEnabled === undefined) {
      delete process.env.DEV_TOOLS_ENABLED;
    } else {
      process.env.DEV_TOOLS_ENABLED = originalDevToolsEnabled;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it(
    'refuses to compile AppModule at all, closing /dev/admin/* and /dev/entitlements/* together (no server ever exists to reach either)',
    async () => {
      await expect(
        Test.createTestingModule({ imports: [AppModule] }).compile(),
      ).rejects.toThrow(/Refusing to boot with DEV_TOOLS_ENABLED=true/);
    },
    e2eSuiteBootBudgetMs(),
  );
});
