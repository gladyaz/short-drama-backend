import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { redactSensitiveText } from '../../common/logging/redact';
import { buildSourceObjectKey } from '../../media/media-storage-key.util';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { parseHlsRenditions } from '../hls-rendition-summary.util';
import {
  buildHlsHomePrefix,
  deriveActiveGenerationPrefix,
} from '../hls-staging-key.util';
import { ProcessingState, TranscodeErrorCode } from '../transcode.types';
import {
  HlsDemoteCurrentState,
  HlsDemotePlan,
  HlsDemotePlaybackOutcome,
  HlsDemoteRefusalCode,
  HlsDemoteReport,
} from './hls-demote.types';

/** The `processingErrorCode` a demoted row carries. Part of the closed `TranscodeErrorCode` set. */
export const HLS_DEMOTE_ERROR_CODE: TranscodeErrorCode = 'DEMOTED';

export interface HlsDemoteRequest {
  videoId: string;
  /** The `Video.processingVersion` the operator expects to be live. The CAS token. */
  expectedGeneration: number;
  /** `false` (the default) reports only and writes nothing. */
  apply: boolean;
  /** Permits demoting a row that would be left with no playable source at all. */
  allowUnplayable: boolean;
}

/**
 * Work unit "HLS DEMOTE": stops ONE video advertising ONE named, currently
 * live HLS generation. See `hls-demote.types.ts` for why this is a demotion
 * and not a rollback — there is no previous generation recorded anywhere to
 * roll back to, and this service deliberately invents none.
 *
 * ## What it writes (only under `apply: true`)
 *
 * Exactly one guarded `updateMany`, whose WHERE clause is a four-way
 * compare-and-set on `(id, processingVersion, processingState: "ready",
 * hlsMasterKey)`. Naming the pointer VALUE itself in the WHERE clause — not
 * just the version — is what makes a stale operator command structurally
 * incapable of demoting a generation it did not name: if anything promoted,
 * failed, or was already demoted between this service's read and its write,
 * the statement matches zero rows and NOTHING changes.
 *
 * It clears `hlsMasterKey`/`hlsRenditions`/`transcodeProfileVersion` (the
 * three columns `promoteIfCurrent` writes as a set, cleared as the same set
 * so they can never disagree) and moves the processing axis to
 * `failed`/`DEMOTED`. `failed` is the truthful state: this generation is not
 * usable, and the row is re-transcodable exactly as any other failed row is
 * (`hls:wave-enqueue` bumps `processingVersion` and queues a fresh
 * generation).
 *
 * ## What it never touches
 *
 * - `lifecycleState` — demotion is a PROCESSING-axis decision, never an
 *   editorial one. A published row stays published and keeps serving its
 *   source MP4; unpublishing it is a separate, deliberate admin action.
 * - Object storage. This service holds a `StorageService` solely to `HEAD`
 *   the source object as a read-only safety check; it calls no delete, no
 *   put, and no list. The bad generation's objects are left in place — see
 *   the runbook's ROLLBACK/DEMOTE section for why that is the safer default,
 *   and for the janitor's role in reclaiming them afterwards.
 * - Any other video. Every statement is `id`-scoped; there is no prefix
 *   match, no `in`, and no wildcard anywhere in this file.
 */
@Injectable()
export class HlsDemoteService {
  private readonly logger = new Logger(HlsDemoteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async run(request: HlsDemoteRequest): Promise<HlsDemoteReport> {
    const base = {
      generatedAt: new Date(),
      apply: request.apply,
      videoId: request.videoId,
      expectedGeneration: request.expectedGeneration,
      allowUnplayable: request.allowUnplayable,
      demoted: false,
    };

    const row = await this.prisma.video.findUnique({
      where: { id: request.videoId },
      select: {
        id: true,
        lifecycleState: true,
        processingState: true,
        processingVersion: true,
        hlsMasterKey: true,
        hlsRenditions: true,
        transcodeProfileVersion: true,
        objectStorageKey: true,
        storageKey: true,
      },
    });

    if (!row) {
      return {
        ...base,
        refusal: {
          code: 'ROW_NOT_FOUND',
          detail: `No Video row with id "${request.videoId}".`,
        },
      };
    }

    const current: HlsDemoteCurrentState = {
      processingState: row.processingState,
      processingVersion: row.processingVersion,
      hlsMasterKey: row.hlsMasterKey,
      transcodeProfileVersion: row.transcodeProfileVersion,
      lifecycleState: row.lifecycleState,
      renditions: parseHlsRenditions(row.hlsRenditions).map((rendition) => ({
        name: rendition.name,
        width: rendition.width,
        height: rendition.height,
      })),
      objectStorageKey: row.objectStorageKey,
      storageKey: row.storageKey,
    };

    const refuse = (
      code: HlsDemoteRefusalCode,
      detail: string,
    ): HlsDemoteReport => ({ ...base, current, refusal: { code, detail } });

    // ---- Safety gates. Every one of these returns BEFORE any write. ----

    if (row.processingState === null) {
      return refuse(
        'NOT_AN_HLS_PIPELINE_ROW',
        'processingState IS NULL — the HLS pipeline has never run for this ' +
          'row, so there is nothing to demote.',
      );
    }

    if (row.processingVersion !== request.expectedGeneration) {
      return refuse(
        'GENERATION_MISMATCH',
        `--generation ${request.expectedGeneration} does not match this ` +
          `row's current processingVersion ${row.processingVersion}. This ` +
          'command is stale; re-read the row before retrying.',
      );
    }

    if (!row.hlsMasterKey) {
      return refuse(
        'NO_ACTIVE_HLS_GENERATION',
        'hlsMasterKey IS NULL — no generation is being advertised. (This is ' +
          'also the answer to a demote that already succeeded.)',
      );
    }

    if (row.processingState !== ('ready' satisfies ProcessingState)) {
      return refuse(
        'NOT_READY',
        `processingState is ${JSON.stringify(row.processingState)}, not ` +
          '"ready". A row that is not "ready" is not advertising HLS at all ' +
          '(VideosService requires BOTH "ready" and a master key), and a row ' +
          'mid-flight must not be demoted out from under its worker.',
      );
    }

    const generationPrefix = deriveActiveGenerationPrefix(row.hlsMasterKey);
    const homePrefix = buildHlsHomePrefix(row.id);

    if (!generationPrefix || !generationPrefix.startsWith(homePrefix)) {
      return refuse(
        'MASTER_KEY_FOREIGN',
        `The live pointer ${JSON.stringify(row.hlsMasterKey)} does not live ` +
          `under this video's own home prefix "${homePrefix}". Refusing to ` +
          'act on a pointer this row does not structurally own.',
      );
    }

    if (!ownsGeneration(generationPrefix, homePrefix, row.processingVersion)) {
      return refuse(
        'GENERATION_POINTER_MISMATCH',
        `The live pointer's generation prefix ${JSON.stringify(generationPrefix)} ` +
          `does not carry "v${row.processingVersion}-". The pointer and the ` +
          'version column disagree, so which generation is live cannot be ' +
          'proven from the row alone.',
      );
    }

    const resultingPlayback = await this.resolvePostDemotionPlayback(row);

    if (resultingPlayback.kind === 'unavailable' && !request.allowUnplayable) {
      return refuse(
        'NO_PLAYBACK_FALLBACK',
        'Demoting would leave this row with no playable source at all ' +
          '(neither objectStorageKey nor storageKey is set), so ' +
          'GET /videos/:id/playback would answer 409 ' +
          'MEDIA_PLAYBACK_SOURCE_UNAVAILABLE. Pass --allow-unplayable to ' +
          'accept that outcome deliberately.',
      );
    }

    if (
      resultingPlayback.kind === 'r2' &&
      !resultingPlayback.sourceObjectPresent &&
      !request.allowUnplayable
    ) {
      return refuse(
        'NO_PLAYBACK_FALLBACK',
        `The fallback source object ${JSON.stringify(resultingPlayback.objectStorageKey)} ` +
          'is missing from storage, so demoting would leave this row ' +
          'advertising an MP4 that cannot be fetched. Pass ' +
          '--allow-unplayable to accept that outcome deliberately.',
      );
    }

    const plan: HlsDemotePlan = {
      masterKey: row.hlsMasterKey,
      generationPrefix,
      renditions: current.renditions,
      // The source MP4 is the one object a demotion must never disturb. It
      // lives OUTSIDE the `hls/` sub-namespace by construction, so this is a
      // structural guarantee, not a runtime check — stated here so the
      // dry-run report says so out loud.
      untouchedObjects: [
        buildSourceObjectKey(row.id),
        ...(row.objectStorageKey &&
        row.objectStorageKey !== buildSourceObjectKey(row.id)
          ? [row.objectStorageKey]
          : []),
      ],
      resultingPlayback,
    };

    if (!request.apply) {
      return { ...base, current, plan };
    }

    const demoted = await this.demoteIfCurrent(
      row.id,
      request.expectedGeneration,
      row.hlsMasterKey,
    );

    if (demoted === 0) {
      return {
        ...base,
        current,
        plan,
        refusal: {
          code: 'CAS_LOST',
          detail:
            'The guarded write matched zero rows — the row changed between ' +
            'this command reading it and writing. NOTHING was modified. ' +
            'Re-run the dry run to see the current state.',
        },
      };
    }

    this.logger.warn(
      redactSensitiveText(
        `Demoted HLS generation v${request.expectedGeneration} for media ` +
          `"${row.id}" — ${JSON.stringify(row.hlsMasterKey)} is no longer ` +
          `advertised. Objects were NOT deleted. Playback now resolves as ` +
          `"${resultingPlayback.kind}".`,
      ),
    );

    return { ...base, current, plan, demoted: true };
  }

  /**
   * THE guarded write. A four-way compare-and-set: the row must still be the
   * same id, at the same `processingVersion`, still `"ready"`, and still
   * pointing at the exact same `hlsMasterKey` the caller decided against.
   * Any drift ⇒ zero rows matched ⇒ zero columns written.
   *
   * Deliberately clears the three promotion columns as ONE set, mirroring
   * `TranscodeIntentService.promoteIfCurrent`'s own "written together so they
   * can never describe different generations" property in reverse.
   */
  private async demoteIfCurrent(
    videoId: string,
    expectedVersion: number,
    expectedMasterKey: string,
  ): Promise<number> {
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        processingVersion: expectedVersion,
        processingState: 'ready' satisfies ProcessingState,
        hlsMasterKey: expectedMasterKey,
      },
      data: {
        hlsMasterKey: null,
        // `Prisma.DbNull` (true SQL NULL), never `Prisma.JsonNull` (which
        // would persist the JSON scalar `null` and read back as a value) —
        // same distinction `AuthService` already documents for its own
        // wholesale metadata clear.
        hlsRenditions: Prisma.DbNull,
        transcodeProfileVersion: null,
        processingState: 'failed' satisfies ProcessingState,
        processingStep: null,
        processingErrorCode: HLS_DEMOTE_ERROR_CODE,
        processingErrorMessage: buildDemotionMessage(
          expectedVersion,
          expectedMasterKey,
        ),
        processingCompletedAt: new Date(),
      },
    });

    return result.count;
  }

  /**
   * The truthful post-demotion answer, derived by applying the SAME rule
   * `resolvePlaybackSource` uses (R2 wins over local, neither ⇒ fail closed)
   * to this row's own columns. Deliberately re-stated as a report value
   * rather than by calling that function, because this method must report
   * the "no source" case as data — `resolvePlaybackSource` throws for it,
   * which is right for a request path and wrong for a dry run.
   *
   * For the R2 case it additionally HEADs the object: an operator is told
   * whether the MP4 they are about to fall back to actually exists. This is
   * the only storage call this service makes, and it is read-only.
   */
  private async resolvePostDemotionPlayback(row: {
    objectStorageKey: string | null;
    storageKey: string;
  }): Promise<HlsDemotePlaybackOutcome> {
    if (row.objectStorageKey && row.objectStorageKey.length > 0) {
      const head = await this.storageService.headObject(row.objectStorageKey);

      return {
        kind: 'r2',
        objectStorageKey: row.objectStorageKey,
        sourceObjectPresent: Boolean(head && head.contentLength > 0),
      };
    }

    if (row.storageKey && row.storageKey.length > 0) {
      return { kind: 'local', storageKey: row.storageKey };
    }

    return { kind: 'unavailable' };
  }
}

/**
 * Records WHICH generation was demoted in the row's own bounded, secret-free
 * `processingErrorMessage`. An object key is an identifier, not an
 * authorization (the same reasoning `run-series-cover-orphans-cli.ts` prints
 * keys under), and it is the one piece of information an operator needs if a
 * demotion later turns out to have been the mistake: the objects are still
 * in storage under that exact prefix until the janitor reclaims them.
 *
 * This is an AUDIT trail, not restorable state — nothing reads this column
 * back to re-promote anything, and `recordIntent` clears it the moment a
 * fresh generation is requested.
 */
function buildDemotionMessage(version: number, masterKey: string): string {
  return (
    `Generation v${version} (${masterKey}) was demoted by an operator and is ` +
    'no longer advertised. Storage was not deleted. Re-transcode to publish ' +
    'a new generation.'
  );
}

/**
 * Whether a generation prefix genuinely belongs to `version` — i.e. its path
 * segment directly under `admin-media/<id>/hls/` starts with `v<version>-`,
 * the exact shape `buildHlsStagingPrefix` produces. Guards against a
 * hand-edited or otherwise inconsistent pointer where the column and the key
 * disagree about which generation is live.
 */
function ownsGeneration(
  generationPrefix: string,
  homePrefix: string,
  version: number,
): boolean {
  return generationPrefix.slice(homePrefix.length).startsWith(`v${version}-`);
}
