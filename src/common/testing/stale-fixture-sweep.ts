import type { PrismaClient } from '@prisma/client';
import {
  TEST_FIXTURE_EMAIL_DOMAIN,
  TEST_FIXTURE_MARKER_PATTERN,
  TEST_FIXTURE_NAMESPACE_PATTERN,
} from './fixture-namespace.helpers';
import { assertTestFixtureCleanupAllowed } from './test-database-guard';

/**
 * How long a per-run fixture namespace must have been SILENT before a later
 * run is allowed to reclaim it.
 *
 * WHY A HORIZON AT ALL. Two Jest runs (two worktrees, or a unit gate and an
 * e2e gate) legitimately share one database, and a namespace belonging to a
 * run that is still in flight must never be touched — deleting it would
 * reintroduce, from the other direction, exactly the cross-run fixture
 * deletion that `fixture-namespace.helpers.ts` was written to eliminate.
 * Age is the only evidence available: the namespace itself encodes a pid and
 * random bytes, not a timestamp (see that file), so staleness is derived
 * from the row timestamps the namespace's own fixtures carry.
 *
 * WHY SIX HOURS, measured on this project rather than guessed:
 *
 *   - one full backend gate: `npm test` 111 s + `npm run test:e2e` 56 s,
 *     i.e. under 3 minutes of wall clock;
 *   - the same two gates run CONCURRENTLY (the deliberately overloaded
 *     8-core reproduction used by this slice): 193 s and 123 s;
 *   - a repeated-gate session of the kind this slice's own validation runs
 *     (10x targeted e2e plus several full e2e passes): ~30 minutes.
 *
 * Six hours is ~120x a single full gate and ~12x the longest repeated-gate
 * session measured here. It is deliberately NOT a tight window: an
 * aggressive threshold (five minutes, say) would be an availability bug
 * aimed straight at a colleague's in-flight run, whereas an over-generous
 * one costs nothing but a few orphaned rows lingering slightly longer in a
 * developer's own database. When in doubt this number should grow, never
 * shrink.
 *
 * Centralized here on purpose: `globalSetup` is the only caller that applies
 * it, and nothing else in the repository may define a second, competing
 * staleness rule.
 */
export const STALE_TEST_FIXTURE_HORIZON_MS = 6 * 60 * 60 * 1000;

/** Per-fixture-domain row counts removed by one sweep. */
export interface StaleFixtureSweepCounts {
  authAuditEvents: number;
  analyticsEvents: number;
  videos: number;
  series: number;
  users: number;
}

export interface StaleFixtureSweepResult {
  /** The namespaces judged abandoned and reclaimed, in discovery order. */
  namespaces: string[];
  counts: StaleFixtureSweepCounts;
}

export interface SweepStaleTestFixturesOptions {
  /**
   * Only namespaces whose most recent row is older than this are swept.
   * Defaults to `STALE_TEST_FIXTURE_HORIZON_MS`.
   */
  maxAgeMs?: number;
  /**
   * When present, restricts the sweep to exactly these namespaces and skips
   * the age rule entirely. Used ONLY by `globalTeardown`, which sweeps the
   * namespaces this very run registered as its own (see
   * `fixture-namespace-registry.ts`) — rows whose owning processes have just
   * exited, so there is nothing to protect them from. When absent, the sweep
   * discovers abandoned namespaces by age.
   */
  onlyNamespaces?: readonly string[];
  /** Injectable clock, so the age rule can be tested without waiting. */
  now?: () => number;
}

/**
 * Reclaims database rows left behind by ABANDONED Jest runs.
 *
 * WHY THIS EXISTS (Test-infrastructure hardening slice). Per-run fixture
 * namespaces fixed cross-worktree fixture deletion, but they gave up the
 * accidental self-healing property the old hardcoded marker had: a run that
 * is SIGKILLed, or dies when its terminal window closes, never reaches its
 * `afterEach`/`afterAll`, and no later run will ever delete those rows
 * because every later run owns a different namespace. That trade-off was
 * recorded as a known, accepted cost in `fixture-namespace.helpers.ts` with
 * a follow-up noted; this function is that follow-up. It was not
 * theoretical: at the time it was written the two local databases held 73
 * such orphaned accounts across 9 abandoned namespaces, the oldest four and
 * a half hours old.
 *
 * WHAT MAY BE DELETED — the ownership rule, deliberately narrow. A row is a
 * candidate only if it carries a marker whose SHAPE is
 * `TEST_FIXTURE_MARKER_PATTERN`: the literal `t`, the base-36 digits of an
 * OS process id, six hex digits of `randomBytes(3)`, and a hyphen. That
 * shape is produced by exactly one module in this repository
 * (`fixture-namespace.helpers.ts`) and is not a name a human would type. For
 * `User` the address must ALSO end in `@example.test`, an IANA-reserved TLD
 * that can never resolve. Both halves are required, and neither is a fuzzy
 * heuristic:
 *
 *   - "email contains test", "title contains fixture" and similar substring
 *     rules are NOT used, and must never be. These databases legitimately
 *     hold developer and QA accounts — `admin@demo.local`,
 *     `qa-admin@local.test`, `qa-iklan@example.com`,
 *     `qa12-...@example.invalid` — every one of which such a rule would
 *     destroy, and none of which matches the shape above.
 *   - The older specs that still use a hardcoded literal prefix
 *     (`analytics-e2e-spec+11b3`, `videos-e2e-spec+10b3`, ...) are also left
 *     alone. They kept the self-healing property this function restores —
 *     the next run of that same spec sweeps them by literal — so they need
 *     nothing from here, and claiming them would widen the ownership rule
 *     for no benefit.
 *   - Seeded catalog rows (`Video`/`Series` from `prisma/seed.ts`, ids like
 *     `video-104-01`) match nothing here, and `prisma/seed.ts` creates no
 *     `User` rows at all.
 *
 * WHEN IT MAY BE DELETED. Never on marker alone. A namespace is reclaimed
 * only once the most recent timestamped row anywhere in it is older than
 * `maxAgeMs` (see `STALE_TEST_FIXTURE_HORIZON_MS`). A namespace is one Jest
 * worker process, and a worker creates rows continuously while it runs, so
 * "nothing from this namespace for six hours" is strong evidence that its
 * process is gone.
 *
 * WHERE IT MAY RUN. `assertTestFixtureCleanupAllowed` is called FIRST,
 * before a single Prisma call, so a refusal means literally no database
 * activity happened — not "we decided not to delete after already querying".
 *
 * WHAT THE AGE COMPARISON DEPENDS ON. Every timestamp column involved is
 * PostgreSQL `timestamp without time zone` with `DEFAULT CURRENT_TIMESTAMP`,
 * and Prisma both writes and reads those values as UTC — so
 * `row.createdAt.getTime()` is a true epoch and comparing it against
 * `Date.now()` is comparing like with like. Two things keep that from
 * becoming a silent hazard. The guard requires the database to be on
 * loopback, so there is no host-to-host clock skew to reason about. And a
 * row somehow written through a session whose `TimeZone` is not UTC lands in
 * the fail-SAFE direction for every zone ahead of UTC — it reads as NEWER
 * than it is, and is protected from the sweep rather than exposed to it.
 *
 * This is TEST ENVIRONMENT hygiene, not business retention. It shares no
 * code path with `RetentionService`, applies no retention policy, and knows
 * nothing about account lifecycle rules.
 */
export async function sweepStaleTestFixtures(
  prisma: PrismaClient,
  options: SweepStaleTestFixturesOptions = {},
): Promise<StaleFixtureSweepResult> {
  assertTestFixtureCleanupAllowed();

  const namespaces =
    options.onlyNamespaces !== undefined
      ? [...options.onlyNamespaces].filter(isWellFormedNamespace)
      : await findStaleNamespaces(prisma, options);

  const counts: StaleFixtureSweepCounts = {
    authAuditEvents: 0,
    analyticsEvents: 0,
    videos: 0,
    series: 0,
    users: 0,
  };

  for (const namespace of namespaces) {
    const swept = await sweepNamespace(prisma, namespace);
    counts.authAuditEvents += swept.authAuditEvents;
    counts.analyticsEvents += swept.analyticsEvents;
    counts.videos += swept.videos;
    counts.series += swept.series;
    counts.users += swept.users;
  }

  return { namespaces, counts };
}

/**
 * The namespaces with at least one timestamped row, none of it newer than
 * the horizon.
 *
 * Each source below pairs a marker column with the timestamp on the SAME
 * row, so a namespace's age is always measured from evidence it actually
 * left behind. `AnalyticsEvent` has no `createdAt`; its `receivedAt`
 * (`@default(now())`) is the equivalent server-side insert time.
 *
 * `Video` is absent from this list because the model carries no timestamp at
 * all, so a video can never establish its own namespace's age. Videos are
 * still RECLAIMED (see `sweepNamespace`) once some timestamped sibling —
 * in practice the namespaced `Series` row the spec created them under — has
 * proved the namespace abandoned. A hypothetical namespace consisting of
 * videos and nothing else is therefore left in place rather than guessed at.
 */
async function findStaleNamespaces(
  prisma: PrismaClient,
  options: SweepStaleTestFixturesOptions,
): Promise<string[]> {
  const now = options.now?.() ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_TEST_FIXTURE_HORIZON_MS;
  const cutoff = now - maxAgeMs;

  const [users, series, authAuditEvents, analyticsEvents] = await Promise.all([
    prisma.user.findMany({
      where: { email: { endsWith: TEST_FIXTURE_EMAIL_DOMAIN } },
      select: { email: true, createdAt: true },
    }),
    prisma.series.findMany({
      where: { id: { startsWith: NAMESPACE_FIRST_CHARACTER } },
      select: { id: true, createdAt: true },
    }),
    prisma.authAuditEvent.findMany({
      where: { userAgent: { startsWith: NAMESPACE_FIRST_CHARACTER } },
      select: { userAgent: true, createdAt: true },
    }),
    prisma.analyticsEvent.findMany({
      where: { eventName: { startsWith: NAMESPACE_FIRST_CHARACTER } },
      select: { eventName: true, receivedAt: true },
    }),
  ]);

  // Most recent activity per namespace. `max`, not `min`: a namespace is
  // abandoned only if NOTHING in it is recent, so a single fresh row
  // protects every older row the same worker created.
  const lastActivityAt = new Map<string, number>();
  const note = (marker: string | null, at: Date): void => {
    const namespace = namespaceOf(marker);
    if (namespace === null) {
      return;
    }
    const previous = lastActivityAt.get(namespace) ?? 0;
    lastActivityAt.set(namespace, Math.max(previous, at.getTime()));
  };

  for (const row of users) {
    note(row.email, row.createdAt);
  }
  for (const row of series) {
    note(row.id, row.createdAt);
  }
  for (const row of authAuditEvents) {
    note(row.userAgent, row.createdAt);
  }
  for (const row of analyticsEvents) {
    note(row.eventName, row.receivedAt);
  }

  return [...lastActivityAt.entries()]
    .filter(([, at]) => at < cutoff)
    .map(([namespace]) => namespace);
}

/**
 * Deletes one abandoned namespace's rows, ordered so that no delete can fail
 * on a foreign key and no row can be silently orphaned.
 *
 * `AuthAuditEvent.userId` and `AnalyticsEvent.userId` are `onDelete: SetNull`
 * (a deliberate schema decision — an audit trail must survive the account it
 * describes), so deleting the `User` first would leave those rows behind
 * with their marker intact but their link severed. They are therefore
 * removed FIRST, matched either by their own namespaced marker or by the
 * namespaced user they belong to: a login through the real HTTP surface
 * writes an audit row whose `userAgent` is supertest's, not a fixture
 * marker, so the `userId` arm is what actually reclaims most of them.
 *
 * Everything else these specs create — `Session`, `Entitlement`,
 * `WatchProgress`, `UserVideoInteraction`, `AccountLockout`,
 * `PasswordResetToken` — is `onDelete: Cascade` from `User` and is reclaimed
 * by the final delete without needing a statement of its own.
 */
async function sweepNamespace(
  prisma: PrismaClient,
  namespace: string,
): Promise<StaleFixtureSweepCounts> {
  const owners = await prisma.user.findMany({
    where: { email: { startsWith: namespace } },
    select: { id: true },
  });
  const ownerIds = owners.map((owner) => owner.id);

  const authAuditEvents = await prisma.authAuditEvent.deleteMany({
    where: {
      OR: [
        { userId: { in: ownerIds } },
        { userAgent: { startsWith: namespace } },
      ],
    },
  });
  const analyticsEvents = await prisma.analyticsEvent.deleteMany({
    where: {
      OR: [
        { userId: { in: ownerIds } },
        { eventName: { startsWith: namespace } },
      ],
    },
  });
  const videos = await prisma.video.deleteMany({
    where: {
      OR: [
        { id: { startsWith: namespace } },
        { seriesId: { startsWith: namespace } },
      ],
    },
  });
  const series = await prisma.series.deleteMany({
    where: { id: { startsWith: namespace } },
  });
  const users = await prisma.user.deleteMany({
    where: { email: { startsWith: namespace } },
  });

  return {
    authAuditEvents: authAuditEvents.count,
    analyticsEvents: analyticsEvents.count,
    videos: videos.count,
    series: series.count,
    users: users.count,
  };
}

/**
 * The single literal character every namespace begins with. Used to keep the
 * candidate queries above cheap (an indexless `startsWith` beats loading a
 * whole table) WITHOUT it ever being the ownership test — every candidate is
 * still put through `namespaceOf` before anything is deleted.
 */
const NAMESPACE_FIRST_CHARACTER = 't';

/**
 * The namespace that owns `marker`, or `null` when `marker` was not produced
 * by `fixture-namespace.helpers.ts`. This is the ONLY place a row is judged
 * to belong to a test run.
 */
function namespaceOf(marker: string | null): string | null {
  if (marker === null) {
    return null;
  }
  const match = TEST_FIXTURE_MARKER_PATTERN.exec(marker);
  return match === null ? null : match[1];
}

/**
 * Guards the `onlyNamespaces` path, so a caller cannot turn the sweep into
 * an arbitrary prefix delete by passing (say) `''` — which as a `startsWith`
 * predicate would match every row in the table. Checked against the
 * whole-value namespace pattern rather than `namespaceOf`, because a
 * registered namespace is the bare identifier with no marker suffix.
 */
function isWellFormedNamespace(candidate: string): boolean {
  return TEST_FIXTURE_NAMESPACE_PATTERN.test(candidate);
}
