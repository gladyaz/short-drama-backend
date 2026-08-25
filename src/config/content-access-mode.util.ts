import type { ConfigService } from '@nestjs/config';
import {
  ContentAccessMode,
  DEFAULT_CONTENT_ACCESS_MODE,
  RootConfig,
} from './configuration';

/**
 * Work unit "V1 FREE ACCESS POLICY": the ONE place the `'content'` config
 * key is read and the ONE place the fallback to
 * `DEFAULT_CONTENT_ACCESS_MODE` lives. Every service that needs the active
 * mode (`VideosController`'s gate, `VideosService`, `PublicSeriesService`,
 * `AdminMediaService`) calls this in its constructor rather than reaching
 * into `ConfigService` with a literal key of its own — so the mode's name,
 * its config path, and its default cannot drift between them, and the
 * string `'entitlement'`/`'free'` never appears in a service file at all.
 *
 * `configService` is OPTIONAL because `AdminMediaService` injects its own
 * `ConfigService` with `@Optional()` (see its constructor doc comment: some
 * specs construct it with no `ConfigModule` at all). An absent
 * `ConfigService` — and a `ConfigService` whose `get('content')` returns
 * nothing, which is exactly what the several hand-rolled `{ get: () =>
 * <one fixed object> }` spec mocks in this repo do — both resolve to the
 * DEFAULT mode.
 *
 * That fallback direction is deliberate and is the safe one: an unwired or
 * mis-mocked consumer keeps ENFORCING entitlements. The failure mode of a
 * forgotten call site is "premium still gated", never "premium silently
 * given away".
 */
export function readContentAccessMode(
  configService: ConfigService<RootConfig> | undefined,
): ContentAccessMode {
  return (
    configService?.get('content', { infer: true })?.accessMode ??
    DEFAULT_CONTENT_ACCESS_MODE
  );
}
