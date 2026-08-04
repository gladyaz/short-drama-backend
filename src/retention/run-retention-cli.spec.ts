// Mirrors `retention-env-guard.spec.ts`'s existing precedent: load `.env`
// explicitly (this file otherwise never touches Prisma for real, so
// nothing else would load it) and fail closed if `DATABASE_URL_TEST` is not
// configured, rather than silently running the allowed-env case below
// against `undefined`.
import 'dotenv/config';
import { PrismaService } from '../prisma/prisma.service';
import { assertDestructiveRetentionAllowed } from './retention-env-guard';
import { runRetentionCli, RunRetentionCliDeps } from './run-retention-cli';
import { RetentionService } from './retention.service';
import { RetentionReport } from './retention.types';

if (!process.env.DATABASE_URL_TEST) {
  throw new Error(
    'DATABASE_URL_TEST is not set in .env — this spec exercises the ' +
      '--commit + allowed-env case, which requires DATABASE_URL to match ' +
      'DATABASE_URL_TEST for the database-identity gate to pass. Copy ' +
      '.env.example and set DATABASE_URL_TEST before running npm test.',
  );
}

const FAKE_REPORT: RetentionReport = {
  generatedAt: new Date('2026-08-04T00:00:00.000Z'),
  commit: false,
  targets: [],
};

/**
 * Phase 13, work unit 13A-B1 (closes `TASK_QUEUE.md` follow-up item 22,
 * approved `DECISIONS.md` 2026-08-04): regression coverage for the exact
 * property this work unit fixes — `assertDestructiveRetentionAllowed()`
 * must run, and be able to refuse, strictly BEFORE `PrismaService` is
 * constructed or `$connect()`-equivalent (`onModuleInit`) is invoked, for a
 * `--commit` run. Every dependency below wraps the REAL class (`PrismaService`,
 * `RetentionService`) in a `jest.fn()`/`jest.spyOn()` spy — never a
 * hand-rolled fake object — specifically so "never constructed" /
 * "never connected" are provable as calls (or non-calls) against the real
 * production classes, not merely against this test file's own stand-ins.
 *
 * **Non-vacuous-by-mutation proof (required by this work unit):** the
 * "refuses before constructing Prisma" test below was confirmed to fail
 * when `run-retention-cli.ts`'s ordering was temporarily reverted to the
 * pre-fix shape (`deps.createPrisma()` + `await prisma.onModuleInit()`
 * moved BEFORE the `if (commit) { deps.assertDestructiveRetentionAllowed(); }`
 * check), and to pass again once the source was restored byte-for-byte.
 * See this work unit's handoff report for the exact mutation diff and
 * before/after test output; not re-encoded here as an automated check
 * because it requires editing the source file at test time, which this
 * repo's other mutation-proof precedents (`retention-env-guard.spec.ts`,
 * `retention.service.spec.ts`) also do not do.
 */
describe('runRetentionCli', () => {
  let originalNodeEnv: string | undefined;
  let originalDatabaseUrl: string | undefined;

  let onModuleInitSpy: jest.SpiedFunction<PrismaService['onModuleInit']>;
  let onModuleDestroySpy: jest.SpiedFunction<PrismaService['onModuleDestroy']>;
  let runSpy: jest.SpiedFunction<RetentionService['run']>;
  let createPrisma: jest.Mock<PrismaService, []>;
  let createRetentionService: jest.Mock<RetentionService, [PrismaService]>;
  let assertDestructiveRetentionAllowedSpy: jest.Mock<void, [string?]>;
  let deps: RunRetentionCliDeps;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDatabaseUrl = process.env.DATABASE_URL;

    // `onModuleInit`/`onModuleDestroy` are mocked so this spec never opens a
    // real database connection — the "was it called" assertion is what
    // proves the connect-ordering property, not an actual live connection.
    onModuleInitSpy = jest
      .spyOn(PrismaService.prototype, 'onModuleInit')
      .mockResolvedValue(undefined);
    onModuleDestroySpy = jest
      .spyOn(PrismaService.prototype, 'onModuleDestroy')
      .mockResolvedValue(undefined);
    // `RetentionService.run` is mocked so this spec never issues a real
    // Prisma query either, regardless of whether `onModuleInit` above was
    // mocked — isolates this file to the ordering property alone.
    runSpy = jest
      .spyOn(RetentionService.prototype, 'run')
      .mockResolvedValue(FAKE_REPORT);

    createPrisma = jest.fn(() => new PrismaService());
    createRetentionService = jest.fn(
      (prisma: PrismaService) => new RetentionService(prisma),
    );
    assertDestructiveRetentionAllowedSpy = jest.fn(
      assertDestructiveRetentionAllowed,
    );

    deps = {
      assertDestructiveRetentionAllowed: assertDestructiveRetentionAllowedSpy,
      createPrisma,
      createRetentionService,
      log: jest.fn(),
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DATABASE_URL = originalDatabaseUrl;
    jest.restoreAllMocks();
  });

  it('refuses --commit under a disallowed NODE_ENV WITHOUT ever constructing PrismaService or calling onModuleInit ($connect)', async () => {
    delete process.env.NODE_ENV;

    await expect(runRetentionCli(['--commit'], deps)).rejects.toThrow(
      /Refusing to run retention cleanup destructively/,
    );

    expect(assertDestructiveRetentionAllowedSpy).toHaveBeenCalledTimes(1);
    // The core property this work unit fixes: zero construction, zero
    // connect, for a refused --commit run.
    expect(createPrisma).not.toHaveBeenCalled();
    expect(onModuleInitSpy).not.toHaveBeenCalled();
    expect(createRetentionService).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(onModuleDestroySpy).not.toHaveBeenCalled();
  });

  it('refuses --commit under NODE_ENV=production WITHOUT ever constructing PrismaService or calling onModuleInit ($connect)', async () => {
    process.env.NODE_ENV = 'production';

    await expect(runRetentionCli(['--commit'], deps)).rejects.toThrow(
      /Refusing to run retention cleanup destructively/,
    );

    expect(createPrisma).not.toHaveBeenCalled();
    expect(onModuleInitSpy).not.toHaveBeenCalled();
  });

  it('with --commit and an allowed env, proceeds to construct PrismaService and connect', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;

    await expect(runRetentionCli(['--commit'], deps)).resolves.toBeUndefined();

    expect(assertDestructiveRetentionAllowedSpy).toHaveBeenCalledTimes(1);
    expect(createPrisma).toHaveBeenCalledTimes(1);
    expect(onModuleInitSpy).toHaveBeenCalledTimes(1);
    expect(createRetentionService).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith({ commit: true });
    expect(onModuleDestroySpy).toHaveBeenCalledTimes(1);

    // The gate ran strictly before construction — never after.
    const gateOrder =
      assertDestructiveRetentionAllowedSpy.mock.invocationCallOrder[0];
    const constructOrder = createPrisma.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(constructOrder);
  });

  it('a dry run (no --commit) constructs PrismaService without ever invoking the gate', async () => {
    // Deliberately disallowed, to prove the dry-run path truly never reaches
    // the gate at all — if it did, this would throw and the test would fail.
    delete process.env.NODE_ENV;

    await expect(runRetentionCli([], deps)).resolves.toBeUndefined();

    expect(assertDestructiveRetentionAllowedSpy).not.toHaveBeenCalled();
    expect(createPrisma).toHaveBeenCalledTimes(1);
    expect(onModuleInitSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith({ commit: false });
    expect(onModuleDestroySpy).toHaveBeenCalledTimes(1);
  });
});
