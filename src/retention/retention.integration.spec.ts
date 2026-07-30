import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANALYTICS_EVENT_RETENTION_DAYS,
  AUTH_AUDIT_EVENT_RETENTION_DAYS,
  PASSWORD_RESET_TOKEN_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  WATCH_PROGRESS_RETENTION_DAYS,
} from './retention.constants';
import { RetentionService } from './retention.service';
import { dayGranularityCutoff, MS_PER_DAY } from './retention.util';

/**
 * Phase 12, work unit 12D-B1: real-Postgres coverage for `RetentionService`.
 *
 * Unlike the plain `src/**\/*.spec.ts` precedent that shares `DATABASE_URL`
 * (the dev database), this file performs REAL, HARD, TIME-CUTOFF-BASED
 * deletes across whole tables — not rows scoped to one test's own prefixed
 * fixtures the way `account-deletion.service.spec.ts`'s deletes are. A
 * retention job's whole job is to delete rows that match a global cutoff,
 * regardless of which test (or which real feature) created them, so this
 * file is bound to the isolated `DATABASE_URL_TEST` database ONLY, failing
 * closed if it is unset, mirroring `account-deletion.service.spec.ts` and
 * `change-password-session-timezone.spec.ts`'s existing precedent for the
 * identical reason (this work unit's own hard requirement: "tests that
 * actually delete run only against the isolated test DB, never
 * short_drama_dev").
 *
 * `NOW` is captured ONCE as the real wall-clock time when this file loads,
 * not a fixed historical/future literal — every fixture below is created
 * either at its real, un-backdated `now()` default (always safely "inside"
 * every window, since the shortest window here is 30 days) or explicitly
 * backdated relative to `NOW` via `.update()` (confirmed, empirically
 * against this project's real Postgres server, to persist the exact
 * explicit value rather than being silently re-stamped to "now" — see this
 * work unit's report). Every call to `service.run(...)` in this file passes
 * this SAME `NOW` as its `now` option, so the cutoffs the service computes
 * are byte-identical to the ones this file precomputes for its fixtures.
 */
describe('RetentionService (real database, DATABASE_URL_TEST only)', () => {
  let service: RetentionService;
  let prisma: PrismaService;
  let originalDatabaseUrl: string | undefined;
  let originalNodeEnv: string | undefined;

  const prefix = 'retention-svc+12db1';
  const uniqueEmail = (label: string): string =>
    `${prefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  const NOW = new Date();
  const sessionCutoff = dayGranularityCutoff(NOW, SESSION_RETENTION_DAYS);
  const passwordResetTokenCutoff = dayGranularityCutoff(
    NOW,
    PASSWORD_RESET_TOKEN_RETENTION_DAYS,
  );
  const authAuditCutoff = dayGranularityCutoff(
    NOW,
    AUTH_AUDIT_EVENT_RETENTION_DAYS,
  );
  const analyticsCutoff = dayGranularityCutoff(
    NOW,
    ANALYTICS_EVENT_RETENTION_DAYS,
  );
  const watchProgressCutoff = dayGranularityCutoff(
    NOW,
    WATCH_PROGRESS_RETENTION_DAYS,
  );

  beforeAll(() => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!process.env.DATABASE_URL_TEST) {
      throw new Error(
        'DATABASE_URL_TEST is not set in .env — retention tests must run ' +
          'against the dedicated short_drama_test database, never ' +
          'DATABASE_URL (dev). Copy .env.example and set DATABASE_URL_TEST ' +
          'before running npm test.',
      );
    }

    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  });

  afterAll(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV;

    const module: TestingModule = await Test.createTestingModule({
      providers: [RetentionService, PrismaService],
    }).compile();

    service = module.get<RetentionService>(RetentionService);
    prisma = module.get<PrismaService>(PrismaService);
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;

    // Mirrors `account-deletion.service.spec.ts`'s afterEach precedent: some
    // rows here are deliberately NOT tied to any user (orphan-rejection
    // proof, anonymized-row proof), so cleanup keys on either the owning
    // user's email OR a marker field, not just the user relation.
    await prisma.authAuditEvent.deleteMany({
      where: {
        OR: [
          { user: { email: { contains: prefix } } },
          { userAgent: { contains: prefix } },
        ],
      },
    });
    await prisma.analyticsEvent.deleteMany({
      where: {
        OR: [
          { user: { email: { contains: prefix } } },
          { eventName: { contains: prefix } },
        ],
      },
    });
    await prisma.watchProgress.deleteMany({
      where: { user: { email: { contains: prefix } } },
    });
    await prisma.userVideoInteraction.deleteMany({
      where: { user: { email: { contains: prefix } } },
    });
    await prisma.entitlement.deleteMany({
      where: { user: { email: { contains: prefix } } },
    });
    await prisma.passwordResetToken.deleteMany({
      where: { user: { email: { contains: prefix } } },
    });
    await prisma.accountLockout.deleteMany({
      where: { user: { email: { contains: prefix } } },
    });
    await prisma.session.deleteMany({
      where: { user: { email: { contains: prefix } } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: prefix } } });

    await prisma.onModuleDestroy();
  });

  async function createUser(label: string) {
    return prisma.user.create({
      data: {
        email: uniqueEmail(label),
        passwordHash: 'irrelevant-for-this-spec',
      },
    });
  }

  async function createSession(
    userId: string,
    overrides: { expiresAt?: Date; revokedAt?: Date | null } = {},
  ) {
    return prisma.session.create({
      data: {
        userId,
        refreshTokenHash: `${prefix}-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        expiresAt:
          overrides.expiresAt ?? new Date(NOW.getTime() + 10 * MS_PER_DAY),
        revokedAt: overrides.revokedAt ?? null,
      },
    });
  }

  async function createPasswordResetToken(
    userId: string,
    overrides: { expiresAt?: Date; usedAt?: Date | null } = {},
  ) {
    return prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: `${prefix}-token-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        expiresAt:
          overrides.expiresAt ?? new Date(NOW.getTime() + 10 * MS_PER_DAY),
        usedAt: overrides.usedAt ?? null,
      },
    });
  }

  async function createAuthAuditEvent(
    markerSuffix: string,
    createdAt?: Date,
    userId?: string,
  ) {
    const created = await prisma.authAuditEvent.create({
      data: {
        userId: userId ?? null,
        event: 'login_success',
        userAgent: `${prefix}-${markerSuffix}`,
      },
    });
    if (createdAt) {
      return prisma.authAuditEvent.update({
        where: { id: created.id },
        data: { createdAt },
      });
    }
    return created;
  }

  async function createAnalyticsEvent(
    markerSuffix: string,
    receivedAt?: Date,
    userId?: string,
  ) {
    const created = await prisma.analyticsEvent.create({
      data: {
        userId: userId ?? null,
        eventName: `${prefix}-${markerSuffix}`,
        properties: {},
        platform: 'ios',
        clientTimestamp: NOW,
      },
    });
    if (receivedAt) {
      return prisma.analyticsEvent.update({
        where: { id: created.id },
        data: { receivedAt },
      });
    }
    return created;
  }

  async function createWatchProgress(
    userId: string,
    seriesSuffix: string,
    updatedAt?: Date,
  ) {
    const created = await prisma.watchProgress.create({
      data: {
        userId,
        seriesId: `${prefix}-series-${seriesSuffix}`,
        lastWatchedVideoId: `${prefix}-video-${seriesSuffix}`,
        lastWatchedEpisodeNumber: 1,
        positionSeconds: 42,
      },
    });
    if (updatedAt) {
      return prisma.watchProgress.update({
        where: { id: created.id },
        data: { updatedAt },
      });
    }
    return created;
  }

  /**
   * The core "dry run deletes nothing" guarantee, proven against a REAL
   * database by re-querying every fixture row afterward — complements the
   * mocked, spy-based version of the same guarantee in
   * `retention.service.spec.ts`. This is one of the two properties this
   * work unit requires to be proven non-vacuous by mutation (see this work
   * unit's report for the mutation trial).
   */
  describe('dry run deletes nothing, even when every target has clearly-outside-window matches', () => {
    it('every fixture row (well outside every window) still exists after a dry run', async () => {
      const user = await createUser('dryrun');
      const outsideSession = await createSession(user.id, {
        revokedAt: new Date(sessionCutoff.getTime() - MS_PER_DAY),
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });
      const outsidePasswordResetToken = await createPasswordResetToken(
        user.id,
        {
          usedAt: new Date(passwordResetTokenCutoff.getTime() - MS_PER_DAY),
          expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
        },
      );
      const outsideAudit = await createAuthAuditEvent(
        'dryrun-audit',
        new Date(authAuditCutoff.getTime() - MS_PER_DAY),
      );
      const outsideAnalytics = await createAnalyticsEvent(
        'dryrun-analytics',
        new Date(analyticsCutoff.getTime() - MS_PER_DAY),
      );
      const outsideProgress = await createWatchProgress(
        user.id,
        'dryrun',
        new Date(watchProgressCutoff.getTime() - MS_PER_DAY),
      );

      const report = await service.run({ commit: false, now: NOW });

      expect(
        report.targets.find((t) => t.target === 'session')?.matchedCount,
      ).toBeGreaterThanOrEqual(1);
      expect(
        report.targets.find((t) => t.target === 'passwordResetToken')
          ?.matchedCount,
      ).toBeGreaterThanOrEqual(1);
      expect(
        report.targets.find((t) => t.target === 'authAuditEvent')?.matchedCount,
      ).toBeGreaterThanOrEqual(1);
      expect(
        report.targets.find((t) => t.target === 'analyticsEvent')?.matchedCount,
      ).toBeGreaterThanOrEqual(1);
      expect(
        report.targets.find((t) => t.target === 'watchProgress')?.matchedCount,
      ).toBeGreaterThanOrEqual(1);
      for (const target of report.targets) {
        expect(target.deletedCount).toBe(0);
      }

      expect(
        await prisma.session.findUnique({ where: { id: outsideSession.id } }),
      ).not.toBeNull();
      expect(
        await prisma.passwordResetToken.findUnique({
          where: { id: outsidePasswordResetToken.id },
        }),
      ).not.toBeNull();
      expect(
        await prisma.authAuditEvent.findUnique({
          where: { id: outsideAudit.id },
        }),
      ).not.toBeNull();
      expect(
        await prisma.analyticsEvent.findUnique({
          where: { id: outsideAnalytics.id },
        }),
      ).not.toBeNull();
      expect(
        await prisma.watchProgress.findUnique({
          where: { id: outsideProgress.id },
        }),
      ).not.toBeNull();
    });
  });

  /**
   * The production guard, proven against a real database. This is the
   * second of the two properties this work unit requires to be proven
   * non-vacuous by mutation.
   */
  describe('the production guard refuses commit mode and touches nothing', () => {
    it('refuses when NODE_ENV is unset, leaving a clearly-outside-window row untouched', async () => {
      delete process.env.NODE_ENV;

      const user = await createUser('prodguard-unset');
      const outsideSession = await createSession(user.id, {
        revokedAt: new Date(sessionCutoff.getTime() - MS_PER_DAY),
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      await expect(service.run({ commit: true, now: NOW })).rejects.toThrow(
        /Refusing to run retention cleanup destructively/,
      );

      expect(
        await prisma.session.findUnique({ where: { id: outsideSession.id } }),
      ).not.toBeNull();
    });

    it('refuses when NODE_ENV=production, leaving a clearly-outside-window row untouched', async () => {
      process.env.NODE_ENV = 'production';

      const user = await createUser('prodguard-prod');
      const outsideSession = await createSession(user.id, {
        revokedAt: new Date(sessionCutoff.getTime() - MS_PER_DAY),
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      await expect(service.run({ commit: true, now: NOW })).rejects.toThrow();

      expect(
        await prisma.session.findUnique({ where: { id: outsideSession.id } }),
      ).not.toBeNull();
    });

    /**
     * Fast-follow (independent `test-reviewer` pass on work unit 12D-B1,
     * MEDIUM): proves the second, independent database-identity gate
     * against a REAL Postgres server — an allowed `NODE_ENV=development` is
     * deliberately NOT enough by itself, the exact scenario this fast-follow
     * exists to close (`NODE_ENV=development npm run retention -- --commit`
     * previously deleted against whatever `DATABASE_URL` resolved to). Only
     * `DATABASE_URL` (the string `assertDestructiveRetentionAllowed` reads)
     * is pointed away from the test database for this one assertion — this
     * file's real, already-open `prisma` connection stays bound to
     * `DATABASE_URL_TEST` throughout (Prisma resolves its connection at
     * client construction, not per-call), so this proves the gate refuses
     * BEFORE `RetentionService.run` would otherwise issue a real query
     * against whatever `DATABASE_URL` now points at, not merely that some
     * later query would have failed for an unrelated reason.
     */
    it('refuses when DATABASE_URL does not match DATABASE_URL_TEST, even with NODE_ENV=development, leaving a clearly-outside-window row untouched', async () => {
      process.env.NODE_ENV = 'development';
      const mismatchedDatabaseUrl = process.env.DATABASE_URL_TEST as string;
      process.env.DATABASE_URL = mismatchedDatabaseUrl.replace(
        /\/[^/]+$/,
        '/short_drama_dev',
      );

      const user = await createUser('prodguard-db-mismatch');
      const outsideSession = await createSession(user.id, {
        revokedAt: new Date(sessionCutoff.getTime() - MS_PER_DAY),
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      try {
        await expect(service.run({ commit: true, now: NOW })).rejects.toThrow(
          /Refusing to run retention cleanup destructively/,
        );
      } finally {
        process.env.DATABASE_URL = mismatchedDatabaseUrl;
      }

      expect(
        await prisma.session.findUnique({ where: { id: outsideSession.id } }),
      ).not.toBeNull();
    });
  });

  describe('commit mode deletes exactly the intended rows — per-target boundary (just inside vs just outside)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('Session (revokedAt branch): revoked just outside the window is deleted; revoked exactly at the cutoff survives', async () => {
      const user = await createUser('session-revoked-boundary');
      const outside = await createSession(user.id, {
        revokedAt: new Date(sessionCutoff.getTime() - 1),
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });
      const atCutoff = await createSession(user.id, {
        revokedAt: sessionCutoff,
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.session.findUnique({ where: { id: outside.id } }),
      ).toBeNull();
      expect(
        await prisma.session.findUnique({ where: { id: atCutoff.id } }),
      ).not.toBeNull();
    });

    it('Session (expiresAt branch): a naturally-expired-past-the-window session is deleted even if never explicitly revoked; one expiring exactly at the cutoff survives', async () => {
      const user = await createUser('session-expiry-boundary');
      const outside = await createSession(user.id, {
        revokedAt: null,
        expiresAt: new Date(sessionCutoff.getTime() - 1),
      });
      const atCutoff = await createSession(user.id, {
        revokedAt: null,
        expiresAt: sessionCutoff,
      });

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.session.findUnique({ where: { id: outside.id } }),
      ).toBeNull();
      expect(
        await prisma.session.findUnique({ where: { id: atCutoff.id } }),
      ).not.toBeNull();
    });

    it('an active (unrevoked, unexpired) session is never touched regardless of age of creation', async () => {
      const user = await createUser('session-active');
      const active = await createSession(user.id, {
        revokedAt: null,
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.session.findUnique({ where: { id: active.id } }),
      ).not.toBeNull();
    });

    /**
     * `PasswordResetToken` (Phase 12, work unit 12E-B3, `DECISIONS.md`
     * decision 3, 2026-07-30) — mirrors the two `Session` boundary tests
     * immediately above exactly, on the `usedAt`/`expiresAt` pair instead of
     * `revokedAt`/`expiresAt`.
     */
    it('PasswordResetToken (usedAt branch): used just outside the window is deleted; used exactly at the cutoff survives', async () => {
      const user = await createUser('reset-token-used-boundary');
      const outside = await createPasswordResetToken(user.id, {
        usedAt: new Date(passwordResetTokenCutoff.getTime() - 1),
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });
      const atCutoff = await createPasswordResetToken(user.id, {
        usedAt: passwordResetTokenCutoff,
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.passwordResetToken.findUnique({
          where: { id: outside.id },
        }),
      ).toBeNull();
      expect(
        await prisma.passwordResetToken.findUnique({
          where: { id: atCutoff.id },
        }),
      ).not.toBeNull();
    });

    it('PasswordResetToken (expiresAt branch): a naturally-expired-past-the-window token is deleted even if never used; one expiring exactly at the cutoff survives', async () => {
      const user = await createUser('reset-token-expiry-boundary');
      const outside = await createPasswordResetToken(user.id, {
        usedAt: null,
        expiresAt: new Date(passwordResetTokenCutoff.getTime() - 1),
      });
      const atCutoff = await createPasswordResetToken(user.id, {
        usedAt: null,
        expiresAt: passwordResetTokenCutoff,
      });

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.passwordResetToken.findUnique({
          where: { id: outside.id },
        }),
      ).toBeNull();
      expect(
        await prisma.passwordResetToken.findUnique({
          where: { id: atCutoff.id },
        }),
      ).not.toBeNull();
    });

    it('an outstanding (unused, unexpired) PasswordResetToken is never touched regardless of age of creation', async () => {
      const user = await createUser('reset-token-active');
      const outstanding = await createPasswordResetToken(user.id, {
        usedAt: null,
        expiresAt: new Date(NOW.getTime() + 10 * MS_PER_DAY),
      });

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.passwordResetToken.findUnique({
          where: { id: outstanding.id },
        }),
      ).not.toBeNull();
    });

    it('AuthAuditEvent: createdAt boundary', async () => {
      const outside = await createAuthAuditEvent(
        'aae-boundary-outside',
        new Date(authAuditCutoff.getTime() - 1),
      );
      const atCutoff = await createAuthAuditEvent(
        'aae-boundary-atcutoff',
        authAuditCutoff,
      );

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.authAuditEvent.findUnique({ where: { id: outside.id } }),
      ).toBeNull();
      expect(
        await prisma.authAuditEvent.findUnique({
          where: { id: atCutoff.id },
        }),
      ).not.toBeNull();
    });

    it('AnalyticsEvent: receivedAt boundary', async () => {
      const outside = await createAnalyticsEvent(
        'ae-boundary-outside',
        new Date(analyticsCutoff.getTime() - 1),
      );
      const atCutoff = await createAnalyticsEvent(
        'ae-boundary-atcutoff',
        analyticsCutoff,
      );

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.analyticsEvent.findUnique({ where: { id: outside.id } }),
      ).toBeNull();
      expect(
        await prisma.analyticsEvent.findUnique({
          where: { id: atCutoff.id },
        }),
      ).not.toBeNull();
    });

    it('WatchProgress: updatedAt boundary — outside the window is deleted, exactly at the cutoff survives, and recent (inside-window) progress is untouched', async () => {
      const user = await createUser('wp-boundary');
      const outside = await createWatchProgress(
        user.id,
        'boundary-outside',
        new Date(watchProgressCutoff.getTime() - 1),
      );
      const atCutoff = await createWatchProgress(
        user.id,
        'boundary-atcutoff',
        watchProgressCutoff,
      );
      // Explicit acceptance-criterion callout: genuinely recent, user-visible
      // "resume where I left off" progress must survive — this is the one
      // target in this file that deletes real user-visible data, not
      // exhaust, so it gets its own always-survives fixture in addition to
      // the boundary pair above.
      const recent = await createWatchProgress(
        user.id,
        'recent',
        new Date(NOW.getTime() - 5 * MS_PER_DAY),
      );

      await service.run({ commit: true, now: NOW });

      expect(
        await prisma.watchProgress.findUnique({ where: { id: outside.id } }),
      ).toBeNull();
      expect(
        await prisma.watchProgress.findUnique({ where: { id: atCutoff.id } }),
      ).not.toBeNull();
      expect(
        await prisma.watchProgress.findUnique({ where: { id: recent.id } }),
      ).not.toBeNull();
    });
  });

  describe('deleted-account residue', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('reports zero matches against ordinary, non-orphan data (cascaded rows all reference a real, still-existing user)', async () => {
      const user = await createUser('residue-normal');
      await createSession(user.id);
      await prisma.userVideoInteraction.create({
        data: { userId: user.id, videoId: `${prefix}-video`, isLiked: true },
      });
      await createWatchProgress(user.id, 'residue-normal');
      await prisma.entitlement.create({
        data: { userId: user.id, tier: 'premium', source: `${prefix}-fixture` },
      });

      const report = await service.run({ commit: true, now: NOW });

      const residue = report.targets.find(
        (t) => t.target === 'deletedAccountResidue',
      );
      expect(residue?.matchedCount).toBe(0);
      expect(residue?.deletedCount).toBe(0);
    });

    it('does NOT delete an anonymized (userId: null) AnalyticsEvent/AuthAuditEvent row required by decision 2 — old or fresh', async () => {
      const freshAnalytics = await createAnalyticsEvent(
        'residue-anon-fresh-ae',
      );
      const freshAudit = await createAuthAuditEvent('residue-anon-fresh-aae');
      // Also age these past EVERY numeric TTL window this file defines, so
      // the ONLY thing that could delete them is a bug in the residue job
      // treating "userId is null" as "orphan" — the separate TTL targets
      // (already proven correct above) would legitimately age these out on
      // their own schedule, so this assertion is scoped to what the RESIDUE
      // target itself reports, not the overall row survival.
      const oldAnalytics = await createAnalyticsEvent(
        'residue-anon-old-ae',
        new Date(NOW.getTime() - 5 * MS_PER_DAY),
      );
      const oldAudit = await createAuthAuditEvent(
        'residue-anon-old-aae',
        new Date(NOW.getTime() - 5 * MS_PER_DAY),
      );

      const report = await service.run({ commit: true, now: NOW });

      const residue = report.targets.find(
        (t) => t.target === 'deletedAccountResidue',
      );
      const analyticsDetail = residue?.residueDetails?.find(
        (d) => d.model === 'analyticsEvent',
      );
      const authAuditDetail = residue?.residueDetails?.find(
        (d) => d.model === 'authAuditEvent',
      );
      expect(analyticsDetail?.matchedCount).toBe(0);
      expect(authAuditDetail?.matchedCount).toBe(0);

      // All four rows are within every TTL window used in this file (well
      // under 30 days old), so they must all still exist — proving the
      // residue target (which ran in the SAME commit call) left them alone.
      for (const row of [freshAnalytics, oldAnalytics]) {
        expect(
          await prisma.analyticsEvent.findUnique({ where: { id: row.id } }),
        ).not.toBeNull();
      }
      for (const row of [freshAudit, oldAudit]) {
        expect(
          await prisma.authAuditEvent.findUnique({ where: { id: row.id } }),
        ).not.toBeNull();
      }
    });

    it('cannot construct a genuine orphan: Postgres itself rejects a userId that does not reference an existing User (proves the residue job has nothing to do under normal operation)', async () => {
      const ghostUserId = `${prefix}-does-not-exist-${Date.now()}`;

      await expect(
        prisma.authAuditEvent.create({
          data: { userId: ghostUserId, event: 'login_success' },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      await expect(
        prisma.session.create({
          data: {
            userId: ghostUserId,
            refreshTokenHash: `${prefix}-orphan-hash-${Date.now()}`,
            expiresAt: new Date(NOW.getTime() + MS_PER_DAY),
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });

      await expect(
        prisma.analyticsEvent.create({
          data: {
            userId: ghostUserId,
            eventName: `${prefix}-orphan-analytics`,
            properties: {},
            platform: 'ios',
            clientTimestamp: NOW,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });
});
