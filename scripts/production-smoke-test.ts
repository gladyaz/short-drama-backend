import {
  isAcceptableMediaStatus,
  judgePlaybackUrl,
} from '../src/common/production-smoke/playback-url-guard';

/**
 * Work unit "PRODUCTION SMOKE TEST": validates a DEPLOYED backend end to
 * end, as an anonymous guest, before a Play Store build is pointed at it.
 *
 *   API_BASE_URL=https://api.example.com npm run smoke:production
 *
 * Deliberately standalone: it reads ONE variable, needs no database, no
 * `.env`, no credentials and no Nest context, so it can run from CI or from
 * a laptop against any origin. It never authenticates — everything it checks
 * must work for a signed-out guest, which is exactly what a fresh install
 * does on first launch.
 *
 * WHAT IT IS FOR. A health check proves the process is up. The mobile
 * release preflight proves EXPO_PUBLIC_API_BASE_URL is https and not a LAN
 * address. Neither notices the failure this catalog is actually exposed to:
 * an API that is reachable, healthy, and serving a catalog whose media is
 * still on somebody's laptop. This script fails loudly on exactly that.
 *
 * Every video id is discovered from the live feed — nothing is hardcoded.
 */

const TIMEOUT_MS = 15_000;

interface Failure {
  check: string;
  detail: string;
}

const failures: Failure[] = [];
const passes: string[] = [];

function pass(check: string, detail = ''): void {
  passes.push(detail ? `${check} — ${detail}` : check);
}

function fail(check: string, detail: string): void {
  failures.push({ check, detail });
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function requireBaseUrl(): string {
  const raw = process.env.API_BASE_URL;

  if (!raw) {
    throw new Error(
      'API_BASE_URL is not set. Usage: API_BASE_URL=https://api.example.com npm run smoke:production',
    );
  }

  const base = raw.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`API_BASE_URL is not a valid URL: ${raw}`);
  }

  // Warned, not refused: pointing this at http://localhost:3000 is a
  // legitimate way to rehearse the script before a real origin exists. The
  // PLAYBACK URL checks below are never relaxed, whatever the base is.
  if (parsed.protocol !== 'https:') {
    // eslint-disable-next-line no-console
    console.warn(
      `WARNING: API_BASE_URL is ${parsed.protocol}// — a real production origin must be https.`,
    );
  }

  return base;
}

interface FeedVideo {
  id: string;
  title?: string;
  accessTier?: string;
}

async function main(): Promise<void> {
  const base = requireBaseUrl();
  // eslint-disable-next-line no-console
  console.log(`Smoke-testing ${base} as an anonymous guest\n`);

  // ---- 1. liveness -------------------------------------------------------
  const health = await fetchWithTimeout(`${base}/health`);
  if (health.status === 200) {
    pass('GET /health', '200');
  } else {
    fail('GET /health', `expected 200, got ${health.status}`);
  }

  // ---- 2. launch config --------------------------------------------------
  const ads = await fetchWithTimeout(`${base}/config/ads`);
  if (ads.status === 200) {
    const body = (await ads.json()) as Record<string, unknown>;
    if (typeof body.enabled === 'boolean') {
      pass('GET /config/ads', `200, enabled=${String(body.enabled)}`);
    } else {
      fail('GET /config/ads', 'response has no boolean "enabled" field');
    }
  } else {
    fail('GET /config/ads', `expected 200, got ${ads.status}`);
  }

  // ---- 3. catalog --------------------------------------------------------
  const feedResponse = await fetchWithTimeout(`${base}/videos/feed`);
  if (feedResponse.status !== 200) {
    fail('GET /videos/feed', `expected 200, got ${feedResponse.status}`);
    return report();
  }

  const feed = (await feedResponse.json()) as FeedVideo[];
  if (!Array.isArray(feed) || feed.length === 0) {
    fail(
      'GET /videos/feed',
      'feed is empty — a fresh install would show nothing',
    );
    return report();
  }
  pass('GET /videos/feed', `200, ${feed.length} videos`);

  // ---- 4. pick a guest-playable episode ----------------------------------
  // Chosen from the live response, never hardcoded. A guest can only play
  // `accessTier: "free"`; a premium pick would fail with a correct 403 and
  // be misread as a broken deployment.
  const freeVideo = feed.find((v) => v.accessTier === 'free');
  if (!freeVideo) {
    fail(
      'guest-playable episode',
      `no video in the feed has accessTier "free" (saw: ${[...new Set(feed.map((v) => String(v.accessTier)))].join(', ')}) — a guest can play nothing`,
    );
    return report();
  }
  pass('guest-playable episode', `${freeVideo.id}`);

  // ---- 5. detail ---------------------------------------------------------
  const detail = await fetchWithTimeout(`${base}/videos/${freeVideo.id}`);
  if (detail.status === 200) {
    pass(`GET /videos/${freeVideo.id}`, '200');
  } else {
    fail(`GET /videos/${freeVideo.id}`, `expected 200, got ${detail.status}`);
  }

  // ---- 6. playback authorization ----------------------------------------
  const playbackResponse = await fetchWithTimeout(
    `${base}/videos/${freeVideo.id}/playback`,
  );
  if (playbackResponse.status !== 200) {
    fail(
      `GET /videos/${freeVideo.id}/playback`,
      `expected 200 for a free episode with no token, got ${playbackResponse.status}`,
    );
    return report();
  }
  pass(`GET /videos/${freeVideo.id}/playback`, '200 (no auth header sent)');

  const playback = (await playbackResponse.json()) as {
    playbackUrl?: string;
    masterUrl?: string;
    type?: string;
  };

  // Two response shapes: the HLS branch returns `masterUrl`, everything else
  // returns `playbackUrl`. Both are the URL a player is handed.
  const mediaUrl = playback.masterUrl ?? playback.playbackUrl;

  // ---- 7. THE CHECK THAT MATTERS ----------------------------------------
  const verdict = judgePlaybackUrl(mediaUrl);
  if (verdict.ok) {
    pass('playback URL is publicly usable', verdict.detail);
  } else {
    fail(
      'playback URL is publicly usable',
      `${verdict.rejection}: ${verdict.detail}`,
    );
    return report();
  }

  // ---- 8. the media actually serves --------------------------------------
  // A HEAD can be refused by a presigned URL whose signature covers GET, so
  // this issues a tiny ranged GET: it proves the object serves without
  // pulling an entire episode down.
  let mediaStatus: number;
  try {
    const media = await fetchWithTimeout(mediaUrl!, {
      headers: { Range: 'bytes=0-1023' },
    });
    mediaStatus = media.status;
  } catch (error) {
    fail(
      'media object is reachable',
      `request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return report();
  }

  if (isAcceptableMediaStatus(mediaStatus)) {
    pass(
      'media object serves bytes',
      `${mediaStatus}${mediaStatus === 206 ? ' (range honored)' : ' (full object)'}`,
    );
  } else {
    fail(
      'media object serves bytes',
      `byte-range request returned ${mediaStatus} — the catalog points at media that does not serve`,
    );
  }

  return report();
}

function report(): void {
  // eslint-disable-next-line no-console
  console.log('PASSED:');
  for (const p of passes) {
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${p}`);
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\nFAILED:');
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${f.check}\n      ${f.detail}`);
    }
    // eslint-disable-next-line no-console
    console.error(
      `\n${failures.length} check(s) failed. This origin is NOT ready for a Play Store build.`,
    );
    process.exitCode = 1;
    return;
  }

  // eslint-disable-next-line no-console
  console.log('\nAll checks passed. A guest can stream from this origin.');
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
