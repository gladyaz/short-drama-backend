import {
  ADMIN_MEDIA_INGESTION_STATUSES,
  AdminMediaIngestionSource,
  canRetryTranscode,
  deriveIngestionStatus,
} from './admin-media-status';
import { MediaLifecycleState } from './media-lifecycle.types';
import { PROCESSING_STATES } from '../transcode/transcode.types';

/**
 * Work unit "ADMIN MEDIA INGESTION": the ingestion status projection is a
 * pure function over three columns, so this file needs no database, no
 * storage mock, and no Nest testing module — unlike every other spec in
 * this directory. That is the point of keeping the derivation in its own
 * dependency-free module: the state machine can be proven exhaustively,
 * cheaply, and in isolation from the service that consumes it.
 */
describe('admin media ingestion status', () => {
  const SOURCE_KEY = 'admin-media/media-abc/source';

  function row(
    overrides: Partial<AdminMediaIngestionSource>,
  ): AdminMediaIngestionSource {
    return {
      lifecycleState: MediaLifecycleState.READY,
      objectStorageKey: SOURCE_KEY,
      processingState: null,
      ...overrides,
    };
  }

  describe('deriveIngestionStatus', () => {
    it('reports a draft with no upload key as "draft"', () => {
      expect(
        deriveIngestionStatus(
          row({
            lifecycleState: MediaLifecycleState.DRAFT,
            objectStorageKey: null,
          }),
        ),
      ).toBe('draft');
    });

    it('reports a draft that has been issued an upload key as "awaiting_upload"', () => {
      expect(
        deriveIngestionStatus(
          row({ lifecycleState: MediaLifecycleState.DRAFT }),
        ),
      ).toBe('awaiting_upload');
    });

    // The row completed its upload, but this deployment never requested any
    // HLS processing for it (TRANSCODE_ENABLED off, or a legacy/local row).
    // It must NOT be reported as "queued" — nothing is going to pick it up.
    it('reports a finalized row with no pipeline as "uploaded"', () => {
      expect(deriveIngestionStatus(row({ processingState: null }))).toBe(
        'uploaded',
      );
    });

    it.each(PROCESSING_STATES)(
      'reports processingState "%s" verbatim for a finalized row',
      (processingState) => {
        expect(deriveIngestionStatus(row({ processingState }))).toBe(
          processingState,
        );
      },
    );

    // A draft row is still uploading no matter what the pipeline column
    // says. This combination is unreachable today (nothing requests
    // processing before completeUpload moves the row off draft), which is
    // exactly why the ordering is pinned by a test: a future change that
    // queued work earlier must not make the UI claim an unverified upload
    // is already transcoding.
    it('lets "draft" win over any processing state', () => {
      expect(
        deriveIngestionStatus(
          row({
            lifecycleState: MediaLifecycleState.DRAFT,
            processingState: 'running',
          }),
        ),
      ).toBe('awaiting_upload');
    });

    it('lets a failed lifecycle win over a ready pipeline', () => {
      expect(
        deriveIngestionStatus(
          row({
            lifecycleState: MediaLifecycleState.FAILED,
            processingState: 'ready',
          }),
        ),
      ).toBe('failed');
    });

    it('treats published and unpublished rows as finalized, reading the pipeline column', () => {
      for (const lifecycleState of [
        MediaLifecycleState.PUBLISHED,
        MediaLifecycleState.UNPUBLISHED,
      ]) {
        expect(
          deriveIngestionStatus(
            row({ lifecycleState, processingState: 'ready' }),
          ),
        ).toBe('ready');
      }
    });

    // The column is a plain `String` at rest, so an unrecognised value is
    // representable even though no writer produces one. It must degrade to a
    // defined status rather than throwing and taking a status poll down.
    it('degrades an unrecognised processing state to "uploaded" instead of throwing', () => {
      expect(
        deriveIngestionStatus(row({ processingState: 'something-new' })),
      ).toBe('uploaded');
    });

    it('is total: every lifecycle/processing combination yields a known status', () => {
      const lifecycleStates = Object.values(MediaLifecycleState);
      const processingStates = [...PROCESSING_STATES, null];

      for (const lifecycleState of lifecycleStates) {
        for (const processingState of processingStates) {
          for (const objectStorageKey of [SOURCE_KEY, null]) {
            const status = deriveIngestionStatus({
              lifecycleState,
              objectStorageKey,
              processingState,
            });

            expect(ADMIN_MEDIA_INGESTION_STATUSES).toContain(status);
          }
        }
      }
    });
  });

  describe('canRetryTranscode', () => {
    it('accepts a finalized row whose pipeline failed', () => {
      expect(canRetryTranscode(row({ processingState: 'failed' }))).toBe(true);
    });

    it.each(['queued', 'running', 'ready'] as const)(
      'refuses a row that is currently "%s"',
      (processingState) => {
        expect(canRetryTranscode(row({ processingState }))).toBe(false);
      },
    );

    it('refuses a row that never had a pipeline', () => {
      expect(canRetryTranscode(row({ processingState: null }))).toBe(false);
    });

    // A draft row's bytes were never verified, so there is nothing safe to
    // re-process — the operator must complete (or restart) the upload.
    it('refuses a draft row even when its pipeline column says failed', () => {
      expect(
        canRetryTranscode(
          row({
            lifecycleState: MediaLifecycleState.DRAFT,
            processingState: 'failed',
          }),
        ),
      ).toBe(false);
    });

    // `failed` is terminal in the EDITORIAL machine; re-queueing a
    // transcode for such a row would produce output nothing can publish.
    it('refuses an editorially failed row', () => {
      expect(
        canRetryTranscode(
          row({
            lifecycleState: MediaLifecycleState.FAILED,
            processingState: 'failed',
          }),
        ),
      ).toBe(false);
    });

    it('refuses a row with no source key to re-process', () => {
      expect(
        canRetryTranscode(
          row({ processingState: 'failed', objectStorageKey: null }),
        ),
      ).toBe(false);
    });
  });
});
