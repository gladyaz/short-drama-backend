import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { TEST_FIXTURE_MARKER_PATTERN } from './fixture-namespace.helpers';
import {
  STALE_TEST_FIXTURE_HORIZON_MS,
  sweepStaleTestFixtures,
} from './stale-fixture-sweep';

/**
 * The crash-recovery proof for `sweepStaleTestFixtures`, against the real
 * PostgreSQL database.
 *
 * WHAT THIS FILE HAS TO ESTABLISH. The sweep is the one piece of test
 * infrastructure here that deletes rows it did not create, so "it removes
 * what it should" is only half the requirement. Each scenario below pairs a
 * deletion with the rows that must SURVIVE it:
 *
 *   - fixtures from an abandoned run are reclaimed, including the ones only
 *     reachable through a cascade or a `SetNull` relation;
 *   - fixtures from a run that is still active are untouched, because a
 *     sweep that can delete a colleague's in-flight rows is the same defect
 *     the per-run namespace was introduced to remove, only pointing the
 *     other way;
 *   - developer, QA, and seeded catalog rows are untouched;
 *   - and a bystander account with a row in every table the sweep deletes
 *     from is checked at the end, alongside the seeded catalog, so a
 *     deletion that reached further than an individual test's assertions
 *     still fails the suite.
 *
 * Bound to `DATABASE_URL_TEST` and failing closed if it is unset, following
 * `account-deletion.service.spec.ts` and `retention.integration.spec.ts`
 * rather than the plain `src` precedent of sharing the dev database: this
 * file deliberately creates rows that LOOK abandoned, and the dev database
 * is the one holding a developer's real work.
 *
 * The namespaces below are freshly generated per test from `randomBytes`,
 * never from `TEST_FIXTURE_NAMESPACE`. Using this worker's own namespace
 * would mean back-dating rows the worker still owns, and a concurrently
 * running gate cannot collide with these values anyway (2^24 random
 * suffixes on top of a pid segment no live process is using).
 */
describe('sweepStaleTestFixtures (real database, DATABASE_URL_TEST only)', () => {
  let prisma: PrismaClient;
  let originalDatabaseUrl: string | undefined;
  let baseline: Baseline;
  let bystander: Bystander;

  /** Comfortably past the horizon, so nothing here depends on its value. */
  const LONG_AGO_MS = STALE_TEST_FIXTURE_HORIZON_MS * 4;

  /** A namespace no live worker can be using: the pid segment is random. */
  const syntheticNamespace = (): string =>
    `t${randomBytes(4).toString('hex').slice(0, 5)}${randomBytes(3).toString('hex')}`;

  const createdNamespaces: string[] = [];
  const createdControlEmails: string[] = [];

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!process.env.DATABASE_URL_TEST) {
      throw new Error(
        'DATABASE_URL_TEST is not set in .env — the stale-fixture sweep ' +
          'tests create deliberately abandoned-looking rows and must run ' +
          'against the dedicated short_drama_test database, never against ' +
          'DATABASE_URL (dev). Copy .env.example and set DATABASE_URL_TEST.',
      );
    }

    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
    prisma = new PrismaClient();
    baseline = await catalogCensus(prisma);
    bystander = await createBystander(prisma);
  });

  afterEach(async () => {
    // Independent of the code under test on purpose: a bug in the sweep must
    // not also be the thing that decides whether this file cleans up after
    // itself.
    for (const namespace of createdNamespaces.splice(0)) {
      await removeNamespace(prisma, namespace);
    }
    for (const email of createdControlEmails.splice(0)) {
      await prisma.user.deleteMany({ where: { email } });
    }
  });

  afterAll(async () => {
    // Work unit 13: after every destructive test above, the data that must
    // never move is still exactly where it was.
    //
    // Two complementary checks, and deliberately NOT a whole-table census.
    // This gate runs the sweep's own specs beside `retention.integration.spec.ts`,
    // `account-deletion.service.spec.ts` and others that create and delete
    // their own rows in this same database, concurrently, throughout — so a
    // table-wide count is a measure of what the other workers happened to be
    // doing, and asserting on it produces exactly the kind of intermittent
    // failure this whole slice exists to remove.
    //
    // What IS deterministic: the seeded catalog, which no spec writes to,
    // and a bystander account created here whose rows only this file can
    // touch.
    expect(await catalogCensus(prisma)).toEqual(baseline);
    await expectBystanderIntact(prisma, bystander);
    await removeBystander(prisma, bystander);

    await prisma.$disconnect();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  /** Builds one run's worth of fixtures, aged by `ageMs`. */
  async function seedRun(ageMs: number): Promise<{
    namespace: string;
    userId: string;
  }> {
    const namespace = syntheticNamespace();
    createdNamespaces.push(namespace);
    const at = new Date(Date.now() - ageMs);

    const user = await prisma.user.create({
      data: {
        email: `${namespace}-1-abandoned@example.test`,
        passwordHash: 'not-a-real-hash',
        createdAt: at,
      },
    });

    // Cascade-reachable children: the sweep never names these, so if the
    // final `user.deleteMany` were reordered or dropped they would survive
    // and this file would notice.
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: `${namespace}-refresh`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: at,
      },
    });
    await prisma.entitlement.create({
      data: {
        userId: user.id,
        tier: 'premium',
        source: 'spec-fixture',
        createdAt: at,
      },
    });

    // `SetNull` relations: these outlive their user by design, so they must
    // be removed BEFORE it — one carrying a fixture marker, one carrying
    // only the link, which is the shape a real HTTP login produces.
    await prisma.authAuditEvent.create({
      data: {
        userId: user.id,
        event: 'login_success',
        userAgent: `${namespace}-agent`,
        createdAt: at,
      },
    });
    await prisma.authAuditEvent.create({
      data: {
        userId: user.id,
        event: 'login_success',
        userAgent: 'node-superagent/9.0.0',
        createdAt: at,
      },
    });
    await prisma.analyticsEvent.create({
      data: {
        userId: user.id,
        eventName: `${namespace}-viewed`,
        properties: {},
        platform: 'ios',
        clientTimestamp: at,
        receivedAt: at,
      },
    });

    // A namespaced series plus a video underneath it. `Video` carries no
    // timestamp of its own, so this is the case that proves a video is
    // reclaimed on the strength of its series' age.
    await prisma.series.create({
      data: {
        id: `${namespace}-series`,
        title: 'Abandoned fixture series',
        createdAt: at,
      },
    });
    await prisma.video.create({
      data: {
        id: `${namespace}-series-ep1`,
        seriesId: `${namespace}-series`,
        title: 'Abandoned fixture episode',
        episodeNumber: 1,
        channelName: 'Spec Channel',
        caption: 'Spec fixture caption',
        category: 'drama',
        storageKey: '',
        sourceLanguage: 'zh',
        hasEmbeddedIndonesianSubtitle: true,
        likeCount: 0,
      },
    });

    return { namespace, userId: user.id };
  }

  describe('a crashed previous run', () => {
    it('reclaims every fixture domain it left behind, including cascades and SetNull relations', async () => {
      const { namespace, userId } = await seedRun(LONG_AGO_MS);

      const result = await sweepStaleTestFixtures(prisma);

      expect(result.namespaces).toContain(namespace);
      expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
      expect(await prisma.session.count({ where: { userId } })).toBe(0);
      expect(await prisma.entitlement.count({ where: { userId } })).toBe(0);
      expect(await prisma.authAuditEvent.count({ where: { userId } })).toBe(0);
      expect(
        await prisma.authAuditEvent.count({
          where: { userAgent: { startsWith: namespace } },
        }),
      ).toBe(0);
      expect(await prisma.analyticsEvent.count({ where: { userId } })).toBe(0);
      expect(
        await prisma.series.count({ where: { id: { startsWith: namespace } } }),
      ).toBe(0);
      expect(
        await prisma.video.count({
          where: { seriesId: { startsWith: namespace } },
        }),
      ).toBe(0);
    });

    it('reports what it removed, per fixture domain', async () => {
      await seedRun(LONG_AGO_MS);

      const result = await sweepStaleTestFixtures(prisma);

      expect(result.counts.users).toBeGreaterThanOrEqual(1);
      // Both the marked row and the link-only one.
      expect(result.counts.authAuditEvents).toBeGreaterThanOrEqual(2);
      expect(result.counts.analyticsEvents).toBeGreaterThanOrEqual(1);
      expect(result.counts.series).toBeGreaterThanOrEqual(1);
      expect(result.counts.videos).toBeGreaterThanOrEqual(1);
    });

    it('reclaims several abandoned runs in one pass', async () => {
      const first = await seedRun(LONG_AGO_MS);
      const second = await seedRun(LONG_AGO_MS);

      const result = await sweepStaleTestFixtures(prisma);

      expect(result.namespaces).toEqual(
        expect.arrayContaining([first.namespace, second.namespace]),
      );
      expect(result.counts.users).toBeGreaterThanOrEqual(2);
    });
  });

  describe('a run that is still in flight', () => {
    it('leaves a namespace whose rows are recent completely alone', async () => {
      const { namespace, userId } = await seedRun(0);

      const result = await sweepStaleTestFixtures(prisma);

      expect(result.namespaces).not.toContain(namespace);
      expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
      expect(await prisma.session.count({ where: { userId } })).toBe(1);
      expect(
        await prisma.series.count({ where: { id: { startsWith: namespace } } }),
      ).toBe(1);
      expect(
        await prisma.video.count({
          where: { seriesId: { startsWith: namespace } },
        }),
      ).toBe(1);
    });

    it('protects a long-running suite: one fresh row shields the namespace, old rows and all', async () => {
      // The realistic in-flight shape. A suite that has been running for a
      // while has rows older than the horizon AND rows from a moment ago;
      // taking the OLDEST timestamp as the namespace's age would delete a
      // colleague's fixtures out from under a passing test.
      const { namespace, userId } = await seedRun(LONG_AGO_MS);
      await prisma.authAuditEvent.create({
        data: {
          userId,
          event: 'login_success',
          userAgent: `${namespace}-still-going`,
        },
      });

      const result = await sweepStaleTestFixtures(prisma);

      expect(result.namespaces).not.toContain(namespace);
      expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    });

    it('applies the horizon exactly, at one minute either side of it', async () => {
      // The boundary is exercised by BACK-DATING the fixtures, not by
      // shifting the sweep's clock forward. A clock pushed a whole horizon
      // into the future makes every namespace in the shared database look
      // abandoned, including the in-flight ones belonging to whoever else
      // is running a gate right now — the exact failure this sweep exists
      // to avoid, reintroduced by its own test. Ageing the fixtures instead
      // keeps the blast radius inside this file.
      const kept = await seedRun(STALE_TEST_FIXTURE_HORIZON_MS - 60_000);
      const expired = await seedRun(STALE_TEST_FIXTURE_HORIZON_MS + 60_000);

      const result = await sweepStaleTestFixtures(prisma);

      expect(result.namespaces).not.toContain(kept.namespace);
      expect(await prisma.user.count({ where: { id: kept.userId } })).toBe(1);
      expect(result.namespaces).toContain(expired.namespace);
      expect(await prisma.user.count({ where: { id: expired.userId } })).toBe(
        0,
      );
    });
  });

  describe('rows it must never claim', () => {
    it('leaves a developer account alone however old it is', async () => {
      // Deliberately every shape a substring heuristic would have caught:
      // an address in the same reserved domain, an old timestamp, and a
      // local part containing the word "test".
      const email = `qa-testinfra-${randomBytes(4).toString('hex')}@example.test`;
      createdControlEmails.push(email);
      await prisma.user.create({
        data: {
          email,
          passwordHash: 'not-a-real-hash',
          createdAt: new Date(Date.now() - LONG_AGO_MS),
        },
      });
      await seedRun(LONG_AGO_MS);

      await sweepStaleTestFixtures(prisma);

      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('leaves the seeded catalog alone', async () => {
      const seededSeries = await prisma.series.count({
        where: { id: { startsWith: 'series-' } },
      });
      const seededVideos = await prisma.video.count({
        where: { id: { startsWith: 'video-' } },
      });
      await seedRun(LONG_AGO_MS);

      await sweepStaleTestFixtures(prisma);

      expect(
        await prisma.series.count({ where: { id: { startsWith: 'series-' } } }),
      ).toBe(seededSeries);
      expect(
        await prisma.video.count({ where: { id: { startsWith: 'video-' } } }),
      ).toBe(seededVideos);
    });
  });

  describe('the globalTeardown path', () => {
    it('reclaims a named namespace regardless of age, because its process has already exited', async () => {
      const { namespace, userId } = await seedRun(0);

      const result = await sweepStaleTestFixtures(prisma, {
        onlyNamespaces: [namespace],
      });

      expect(result.namespaces).toEqual([namespace]);
      expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
    });

    it('touches nothing else, even when other namespaces are long abandoned', async () => {
      const abandoned = await seedRun(LONG_AGO_MS);
      const mine = await seedRun(0);

      const result = await sweepStaleTestFixtures(prisma, {
        onlyNamespaces: [mine.namespace],
      });

      expect(result.namespaces).toEqual([mine.namespace]);
      expect(await prisma.user.count({ where: { id: abandoned.userId } })).toBe(
        1,
      );
    });

    it.each([
      [''],
      ['..'],
      ['t'],
      ['%'],
      ['t00abczzzzzz'], // right length, but the tail is not hexadecimal
      ['t00abc1122334455'], // far longer than any pid segment can be
      ['T00ABC112233'], // uppercase: base-36 output is lowercase
      ['t00abc112233-1-label@example.test'], // a marker, not a namespace
    ])(
      'refuses the malformed namespace %p rather than treating it as a prefix',
      async (malformed) => {
        // `''` is the dangerous one: as a `startsWith` predicate it matches
        // every row in the table.
        const { userId } = await seedRun(LONG_AGO_MS);

        const result = await sweepStaleTestFixtures(prisma, {
          onlyNamespaces: [malformed],
        });

        expect(result.namespaces).toEqual([]);
        expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
      },
    );
  });
});

interface Baseline {
  series: number;
  videos: number;
}

/**
 * The seeded catalog: `prisma/seed.ts`'s 40 videos and the curated series
 * rows. Nothing in the test suite creates or deletes these, so a change in
 * either count means the sweep reached data it does not own.
 */
async function catalogCensus(prisma: PrismaClient): Promise<Baseline> {
  const [allSeries, allVideos] = await Promise.all([
    prisma.series.findMany({ select: { id: true } }),
    prisma.video.findMany({ select: { id: true, seriesId: true } }),
  ]);

  return {
    series: allSeries.filter((row) => !TEST_FIXTURE_MARKER_PATTERN.test(row.id))
      .length,
    videos: allVideos.filter(
      (row) =>
        !TEST_FIXTURE_MARKER_PATTERN.test(row.id) &&
        !TEST_FIXTURE_MARKER_PATTERN.test(row.seriesId),
    ).length,
  };
}

interface Bystander {
  email: string;
  userId: string;
}

/**
 * An account that is NOT a test fixture, together with one row in every
 * table the sweep deletes from, standing in for a developer's own data for
 * the lifetime of this file.
 *
 * Every property that a careless ownership rule keys on is present on
 * purpose: the address sits in the same `@example.test` domain the fixtures
 * use, contains the word "test", and is back-dated well past the staleness
 * horizon. The only thing it lacks is the namespace marker — which is
 * precisely the thing the sweep requires.
 */
async function createBystander(prisma: PrismaClient): Promise<Bystander> {
  const suffix = randomBytes(6).toString('hex');
  const email = `qa-testinfra-bystander-${suffix}@example.test`;
  const longAgo = new Date(Date.now() - STALE_TEST_FIXTURE_HORIZON_MS * 8);

  const user = await prisma.user.create({
    data: { email, passwordHash: 'not-a-real-hash', createdAt: longAgo },
  });
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: `bystander-${suffix}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: longAgo,
    },
  });
  await prisma.entitlement.create({
    data: {
      userId: user.id,
      tier: 'premium',
      source: 'spec-bystander',
      createdAt: longAgo,
    },
  });
  await prisma.authAuditEvent.create({
    data: {
      userId: user.id,
      event: 'login_success',
      userAgent: `bystander-${suffix}`,
      createdAt: longAgo,
    },
  });
  await prisma.analyticsEvent.create({
    data: {
      userId: user.id,
      eventName: `bystander-${suffix}`,
      properties: {},
      platform: 'ios',
      clientTimestamp: longAgo,
      receivedAt: longAgo,
    },
  });

  return { email, userId: user.id };
}

/** Every bystander row still present, including the cascade-reachable ones. */
async function expectBystanderIntact(
  prisma: PrismaClient,
  bystander: Bystander,
): Promise<void> {
  const { userId } = bystander;

  expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
  expect(await prisma.session.count({ where: { userId } })).toBe(1);
  expect(await prisma.entitlement.count({ where: { userId } })).toBe(1);
  expect(await prisma.authAuditEvent.count({ where: { userId } })).toBe(1);
  expect(await prisma.analyticsEvent.count({ where: { userId } })).toBe(1);
}

async function removeBystander(
  prisma: PrismaClient,
  bystander: Bystander,
): Promise<void> {
  await prisma.authAuditEvent.deleteMany({
    where: { userId: bystander.userId },
  });
  await prisma.analyticsEvent.deleteMany({
    where: { userId: bystander.userId },
  });
  await prisma.user.deleteMany({ where: { id: bystander.userId } });
}

/**
 * Removes one synthetic namespace by hand, in the order the foreign keys
 * require. Intentionally NOT `sweepStaleTestFixtures`: this file's own
 * cleanup must not depend on the function it is testing.
 */
async function removeNamespace(
  prisma: PrismaClient,
  namespace: string,
): Promise<void> {
  const owners = await prisma.user.findMany({
    where: { email: { startsWith: namespace } },
    select: { id: true },
  });
  const ownerIds = owners.map((owner) => owner.id);

  await prisma.authAuditEvent.deleteMany({
    where: {
      OR: [
        { userId: { in: ownerIds } },
        { userAgent: { startsWith: namespace } },
      ],
    },
  });
  await prisma.analyticsEvent.deleteMany({
    where: {
      OR: [
        { userId: { in: ownerIds } },
        { eventName: { startsWith: namespace } },
      ],
    },
  });
  await prisma.video.deleteMany({
    where: { seriesId: { startsWith: namespace } },
  });
  await prisma.series.deleteMany({ where: { id: { startsWith: namespace } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: namespace } } });
}
