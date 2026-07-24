import { ImportManifestItem } from '../importer.types';

/**
 * Phase 11, work unit 11D-1: a small, deterministic fixture manifest used
 * across `media-importer.service.spec.ts`'s happy-path, idempotent-rerun,
 * and one-failed-item scenarios. `id`s are namespaced under
 * `importer-fixture-...` so tests can clean up unambiguously and never
 * collide with the real seeded catalog or another spec's rows.
 */
export const IMPORT_MANIFEST_FIXTURE: ImportManifestItem[] = [
  {
    id: 'importer-fixture-01',
    seriesId: 'importer-fixture-series',
    title: 'Fixture Episode One',
    episodeNumber: 1,
    channelName: 'Fixture Channel',
    caption: 'Fixture caption one',
    category: 'drama',
    storageKey: 'Fixture Series/1_subtitled.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
  },
  {
    id: 'importer-fixture-02',
    seriesId: 'importer-fixture-series',
    title: 'Fixture Episode Two',
    episodeNumber: 2,
    channelName: 'Fixture Channel',
    caption: 'Fixture caption two',
    category: 'drama',
    storageKey: 'Fixture Series/2_subtitled.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
  },
  {
    id: 'importer-fixture-03',
    seriesId: 'importer-fixture-series',
    title: 'Fixture Episode Three',
    episodeNumber: 3,
    channelName: 'Fixture Channel',
    caption: 'Fixture caption three',
    category: 'drama',
    storageKey: 'Fixture Series/3_subtitled.mp4',
    sourceLanguage: 'zh',
    hasEmbeddedIndonesianSubtitle: true,
  },
];
