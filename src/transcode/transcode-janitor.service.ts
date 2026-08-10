import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redactSensitiveText } from '../common/logging/redact';
import { RootConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  buildHlsHomePrefix,
  deriveActiveGenerationPrefix,
  groupKeysByGenerationPrefix,
} from './hls-staging-key.util';
import { DEFAULT_JANITOR_SWEEP_LIMIT } from './transcode.constants';

/** Bounds a single `cleanupOrphanStaging` sweep's `ListObjectsV2` page size per candidate row. */
const CLEANUP_LIST_MAX_KEYS = 1000;

/**
 * Slice 11P — Production Transcoding Lifecycle (control workspace
 * DECISIONS.md "2026-08-10 — Slice 11P APPROVED..." entry; architecture:
 * `proposals/phase-11-hls-pipeline-proposal.md` §7-§8). The bounded,
 * idempotent janitor `TranscodeJobProcessor` alone cannot cover: recovering
 * a row a crashed/killed worker left stuck `"running"` forever, and
 * reclaiming R2 storage for generations that are neither the active pointer
 * nor still within a safety grace window.
 *
 * Deliberately a SEPARATE class from `TranscodeReconcilerService` (11N) —
 * that service recovers `"queued"` rows whose ENQUEUE may have been lost;
 * this one recovers `"running"` rows whose WORKER may have died, and cleans
 * up orphaned R2 storage — two independent recovery concerns with different
 * triggers, different queries, and different blast radii, better kept as two
 * small, focused classes (this repo's `coding-style.md` "many small files"
 * principle) than merged into one.
 *
 * **Flag-gated, exactly like `TranscodeReconcilerService.reconcile`**: both
 * public methods below return `0` immediately (zero Prisma queries, zero
 * storage calls) when `TRANSCODE_ENABLED` is not exactly `"true"`.
 *
 * **Scheduling** follows the Phase 13 (13A-B2) `RetentionSchedulerService`
 * precedent: an env-gated schedule, OFF by default, with the actual
 * work living in plain injectable methods that are the real, independently
 * testable foundation (mirroring that service's own doc comment: "this
 * slice's job is to prove the reconciliation primitive itself is correct").
 * Unlike 13A-B2, this slice does NOT introduce a SECOND env var to gate a
 * cron registration — `TRANSCODE_ENABLED` itself is already the single,
 * fail-closed gate for this entire feature (default `false`, the only
 * shipped state), so a scheduled loop wired into `src/worker/main.ts`'s
 * flag-on persistent mode (see that file) reuses the SAME flag rather than
 * inventing a second one purely to gate "does the cron exist" on top of a
 * feature that is already off by default. Both methods here remain plain,
 * directly callable, directly testable injectable methods regardless — the
 * scheduling loop is a thin, untested-by-design wrapper (mirrors
 * `transcode-worker.ts`'s "never construct the real thing in a unit test"
 * precedent for the same reason: it would require a real timer/interval).
 */
@Injectable()
export class TranscodeJanitorService {
  private readonly logger = new Logger(TranscodeJanitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Finds rows stuck `"running"` for longer than
   * `TRANSCODE_STALLED_AFTER_MINUTES` (default 30) and CAS-fails them with
   * `STALE` — recoverable via the existing re-request path (a fresh
   * `requestProcessing`/`recordIntent` call bumps `processingVersion` and
   * re-queues; the stale row's own version can never be resurrected, which
   * is exactly the version-guard property `promoteIfCurrent` already
   * depends on elsewhere).
   *
   * Bounded (`limit`), deterministic ordering (`id` ascending, matching
   * `TranscodeReconcilerService.reconcile`'s own documented rationale for
   * why `id` rather than a chronological column is used as the tie-break).
   * The CAS itself (`TranscodeIntentService`-shaped `failWithError`, called
   * here via a raw `prisma.video.updateMany` — see the inline comment below
   * for why this method does not inject `TranscodeIntentService` itself)
   * NEVER touches a row that is not still exactly `(id, expectedVersion,
   * "running")` at write time, so a row that legitimately completed (or was
   * superseded) BETWEEN this method's read and its write is left completely
   * untouched.
   */
  async sweepStaleRunning(
    limit: number = DEFAULT_JANITOR_SWEEP_LIMIT,
  ): Promise<number> {
    const transcodeConfig = this.configService.get('transcode', {
      infer: true,
    });

    if (!transcodeConfig?.enabled) {
      return 0;
    }

    const stalledCutoff = new Date(
      Date.now() - transcodeConfig.stalledAfterMinutes * 60_000,
    );

    const staleRows = await this.prisma.video.findMany({
      where: {
        processingState: 'running',
        processingStartedAt: { lt: stalledCutoff },
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, processingVersion: true, processingStartedAt: true },
    });

    let failedCount = 0;

    for (const row of staleRows) {
      // A raw, inline CAS rather than injecting `TranscodeIntentService`:
      // this is the SAME `updateMany` shape as `TranscodeIntentService
      // .failWithError` (id + expectedVersion + processingState: "running"
      // guard), duplicated here deliberately narrowly (this is the one
      // documented exception noted on `transitionIfVersion`'s own doc
      // comment) rather than adding a cross-service dependency for a single
      // three-line write — `TranscodeJobProcessor`, which performs many
      // MORE distinct CAS writes across a much longer pipeline, is the
      // class that actually benefits from centralizing through
      // `TranscodeIntentService`.
      const stuckForMinutes = row.processingStartedAt
        ? Math.round((Date.now() - row.processingStartedAt.getTime()) / 60_000)
        : undefined;

      const result = await this.prisma.video.updateMany({
        where: {
          id: row.id,
          processingVersion: row.processingVersion,
          processingState: 'running',
        },
        data: {
          processingState: 'failed',
          processingStep: null,
          processingErrorCode: 'STALE',
          processingErrorMessage:
            'Processing was stuck "running" longer than ' +
            `${transcodeConfig.stalledAfterMinutes} minute(s) and was ` +
            'marked failed by the janitor. Re-request processing to retry.',
          processingCompletedAt: new Date(),
        },
      });

      if (result.count > 0) {
        failedCount += 1;
        this.logger.warn(
          redactSensitiveText(
            `Janitor marked media "${row.id}" (version ${row.processingVersion}) ` +
              `failed(STALE) — stuck running for ~${stuckForMinutes ?? 'unknown'} minute(s).`,
          ),
        );
      }
    }

    return failedCount;
  }

  /**
   * Deletes orphaned/superseded HLS staging prefixes for TERMINAL rows
   * (`processingState` is `"ready"` or `"failed"`) — never for a `"running"`
   * or `"queued"` row, whose in-flight generation must never be touched.
   *
   * For each candidate row, in order:
   * 1. Derive the ACTIVE generation prefix from the row's CURRENT
   *    `hlsMasterKey` (`deriveActiveGenerationPrefix`) — `null` if the row
   *    has never had a successful generation.
   * 2. List objects under `admin-media/<id>/hls/` (bounded,
   *    `StorageService.listObjectKeysByPrefix`) and group them by
   *    generation prefix (`groupKeysByGenerationPrefix`).
   * 3. For every generation prefix found in storage that is NOT the active
   *    prefix (structural exclusion — see the assertion below and this
   *    method's own dedicated tests/mutation): compute the newest
   *    `lastModified` among that prefix's objects; if `now - newest >=
   *    TRANSCODE_CLEANUP_GRACE_MINUTES` (default 120 — deliberately LONGER
   *    than the 30-60 minute playback-token TTL design target for the
   *    future 11Q gateway, so a generation a viewer may still hold a live
   *    authorization token for is never deleted out from under them), delete
   *    every object under that prefix.
   *
   * A delete failure for one object is logged loudly and does NOT abort the
   * rest of the sweep (mirrors `HlsSmokeRunner`'s existing
   * "unprovable cleanup ⇒ log loudly, never silently swallowed" precedent) —
   * a partially-cleaned orphan prefix is picked up again on the next sweep.
   */
  async cleanupOrphanStaging(
    limit: number = DEFAULT_JANITOR_SWEEP_LIMIT,
  ): Promise<{ deletedGenerations: number; deletedObjects: number }> {
    const transcodeConfig = this.configService.get('transcode', {
      infer: true,
    });

    if (!transcodeConfig?.enabled) {
      return { deletedGenerations: 0, deletedObjects: 0 };
    }

    const candidateRows = await this.prisma.video.findMany({
      where: { processingState: { in: ['ready', 'failed'] } },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, hlsMasterKey: true },
    });

    const graceMs = transcodeConfig.cleanupGraceMinutes * 60_000;
    let deletedGenerations = 0;
    let deletedObjects = 0;

    for (const row of candidateRows) {
      const homePrefix = buildHlsHomePrefix(row.id);
      const activePrefix = deriveActiveGenerationPrefix(row.hlsMasterKey);

      const entries = await this.storageService.listObjectKeysByPrefix(
        homePrefix,
        CLEANUP_LIST_MAX_KEYS,
      );
      const groups = groupKeysByGenerationPrefix(
        homePrefix,
        entries.map((entry) => entry.key),
      );

      for (const [generationPrefix, keys] of groups) {
        // STRUCTURAL exclusion — never even considered for deletion. This
        // is the invariant proof 11 (and its dedicated mutation test) pin.
        if (generationPrefix === activePrefix) {
          continue;
        }

        const newestLastModified = newestOf(entries, keys);

        // Missing timestamp info (should not happen against a real R2/S3
        // response, but defended against rather than assumed) ⇒ SAFE
        // default is "too new to touch, skip this sweep" — never delete
        // something this method cannot positively prove is old enough.
        if (!newestLastModified) {
          continue;
        }

        const ageMs = Date.now() - newestLastModified.getTime();
        if (ageMs < graceMs) {
          continue; // still within the grace window — never deleted yet.
        }

        let generationDeletedCount = 0;
        for (const key of keys) {
          try {
            await this.storageService.deleteObject(key);
            generationDeletedCount += 1;
          } catch (error) {
            this.logger.error(
              redactSensitiveText(
                `Janitor failed to delete orphaned HLS object "${key}" ` +
                  `(media "${row.id}"): ${String(error)}`,
              ),
            );
          }
        }

        deletedObjects += generationDeletedCount;
        if (generationDeletedCount > 0) {
          deletedGenerations += 1;
          this.logger.log(
            redactSensitiveText(
              `Janitor cleaned up orphaned HLS generation "${generationPrefix}" ` +
                `for media "${row.id}" — ${generationDeletedCount} object(s) deleted.`,
            ),
          );
        }
      }
    }

    return { deletedGenerations, deletedObjects };
  }
}

/** Newest `lastModified` among `keys`, looked up from the flat `entries` list. Returns `undefined` if none carry a timestamp. */
function newestOf(
  entries: { key: string; lastModified?: Date }[],
  keys: readonly string[],
): Date | undefined {
  const keySet = new Set(keys);
  let newest: Date | undefined;

  for (const entry of entries) {
    if (!keySet.has(entry.key) || !entry.lastModified) {
      continue;
    }
    if (!newest || entry.lastModified.getTime() > newest.getTime()) {
      newest = entry.lastModified;
    }
  }

  return newest;
}
