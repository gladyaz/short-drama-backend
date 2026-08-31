import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RootConfig } from '../../config/configuration';
import { buildLocalSeriesCoverUrl } from '../../series/series-cover-url.util';
import { syntheticSignedGetUrlFor } from './storage-mock.helpers';

/**
 * Work unit "LOCAL SERIES COVER ARTWORK": the EXACT `coverUrl` a booted e2e
 * app should return for a given series, whichever storage driver its
 * environment actually selected.
 *
 * WHY NOT JUST LOOSEN THE ASSERTION. The obvious alternative — asserting only
 * that `coverUrl` is a non-null string — would pass for a URL pointing at the
 * wrong series, at a stale key, or at a bucket that does not exist. The URL is
 * the entire deliverable of this contract; an e2e that stops checking it stops
 * testing the thing most likely to break.
 *
 * WHY NOT PIN THE DRIVER INSTEAD. An e2e suite boots the real `AppModule`
 * against the developer's real `.env`, where `STORAGE_DRIVER` is `local`.
 * Forcing `r2` there would assert the behaviour of a configuration that is not
 * the one under test, and would additionally require `validateEnv`'s five
 * `OBJECT_STORAGE_*` names to be present just to run the suite.
 *
 * So the expectation is DERIVED from the same config the app itself read.
 * Both branches stay exact, and the suite is correct in a local checkout and
 * in an r2-configured one without an edit.
 */
export function expectedSeriesCoverUrl(
  app: INestApplication,
  seriesId: string,
  coverImageKey: string,
): string {
  const configService = app.get<ConfigService<RootConfig>>(ConfigService);
  const storage = configService.get('storage', { infer: true })!;

  if (storage.driver === 'local') {
    const appConfig = configService.get('app', { infer: true })!;

    return buildLocalSeriesCoverUrl(appConfig.publicBaseUrl, seriesId);
  }

  // Every e2e suite that resolves a cover mocks `StorageService`, so the
  // presigned branch's answer is the shared synthetic URL, not a real one.
  return syntheticSignedGetUrlFor(coverImageKey);
}
