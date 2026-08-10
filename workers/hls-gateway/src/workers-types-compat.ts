/**
 * 11Q-A1 pre-deploy gate: compile-time assignability of the REAL
 * `@cloudflare/workers-types` ambient types against this gateway's narrow
 * structural types (env.types.ts). This file contains NO runtime code — it
 * exists only so `tsc -p tsconfig.workers-compat.json` fails loudly if the
 * "a real R2Bucket/Cache satisfies our interfaces structurally" claim in
 * env.types.ts ever stops being true.
 *
 * Direction of every check: the REAL runtime type must be usable wherever
 * our narrow type is expected (Real extends Narrow). If a line errors, fix
 * env.types.ts (and any handler code its correction implies) — never widen
 * this check or weaken the narrow types with `any` to make it pass.
 */
import type { CacheLike, Env as GatewayEnv, MediaBucket } from './env.types';

type MustExtend<Narrow, Real extends Narrow> = Real;

/** A real private R2 bucket binding must satisfy MediaBucket. */
export type BucketCompat = MustExtend<MediaBucket, R2Bucket>;

/** The real Workers Cache (`caches.default`) must satisfy CacheLike. */
export type CacheCompat = MustExtend<CacheLike, Cache>;

/**
 * A wrangler-generated Env carrying the real binding must satisfy our Env,
 * so `handleRequest`/the default `fetch` export can be deployed unchanged.
 */
interface RealDeployedEnv {
  MEDIA_BUCKET: R2Bucket;
  HLS_TOKEN_SECRET: string;
  CACHE_ENABLED?: string;
}
export type EnvCompat = MustExtend<GatewayEnv, RealDeployedEnv>;
