import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Phase 11, slice 11K (work unit 11K-B1). Test-only helpers for the
 * OPT-IN, real-network presigned-MP4 smoke test in
 * `storage-r2-media-smoke.spec.ts`, plus its offline unit spec
 * `storage-r2-media-smoke.helpers.spec.ts`.
 *
 * NOTHING in production code imports this module — it is deliberately
 * side-effect free at import time (no `S3Client`, no `fetch`, no
 * `process.env` read, no `.env` load), so merely importing it can never
 * make a network call or touch a credential. It lives under `src/` rather
 * than `test/` only because `package.json`'s Jest `rootDir` is `src`, so a
 * unit spec can only live here.
 *
 * **This module never touches `STORAGE_ROOT` or any real company media.**
 * The only media it produces is a fully synthetic FFmpeg `testsrc` +
 * `sine` clip written into a throwaway `os.tmpdir()` directory.
 *
 * See `docs/r2-readiness.md` section 5 for the runbook.
 */

/** `fs.mkdtemp` prefix, so stray directories are trivially attributable. */
export const MEDIA_SMOKE_TEMP_DIR_PREFIX = '11k-';

/**
 * Object-key prefix for every object this slice creates. Mirrors the
 * `_r2-smoke-tests/` convention 11G-4 established: unmistakably disposable
 * debris, never a real media key shape.
 */
export const MEDIA_SMOKE_KEY_PREFIX = '_r2-media-smoke-tests/';

/** Content type bound into the presigned PUT and asserted back on `HEAD`. */
export const MEDIA_SMOKE_CONTENT_TYPE = 'video/mp4';

/** Synthetic clip shape — deliberately tiny (tens of KB, not MB). */
export const SYNTHETIC_MP4_DURATION_SECONDS = 2;
export const SYNTHETIC_MP4_FRAME_SIZE = '64x64';
export const SYNTHETIC_MP4_FRAME_RATE = 15;
export const SYNTHETIC_MP4_AUDIO_FREQUENCY_HZ = 440;

/**
 * Accepted `ffprobe` duration window for the synthetic clip. FFmpeg's
 * container duration is not exactly `SYNTHETIC_MP4_DURATION_SECONDS` to the
 * microsecond, so the assertion is a band, not an equality.
 */
export const SYNTHETIC_MP4_MIN_DURATION_SECONDS = 1;
export const SYNTHETIC_MP4_MAX_DURATION_SECONDS = 3;

/** Cap on how much `ffmpeg`/`ffprobe` output is buffered (bytes). */
const CHILD_PROCESS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Placeholder substituted for any URL-shaped substring. */
export const REDACTED_URL_PLACEHOLDER = '[redacted-url]';

/** Placeholder substituted for a residual signed query-parameter value. */
export const REDACTED_VALUE_PLACEHOLDER = '[redacted]';

/** Placeholder substituted for a bare SigV4-shaped 64-char hex digest. */
export const REDACTED_SIGNATURE_PLACEHOLDER = '[redacted-signature]';

export interface Mp4ProbeResult {
  /** `ffprobe`'s `format.format_name`, e.g. `mov,mp4,m4a,3gp,3g2,mj2`. */
  formatName: string;
  /** `format.duration` as a number of seconds (not rounded). */
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /**
   * Authoritative on-disk byte count from `fs.stat`, NOT `ffprobe`'s
   * `format.size` — this value is compared for exact equality against the
   * uploaded object's `ContentLength`, so it must be the real file size.
   */
  sizeBytes: number;
}

export interface SignedRequestInit {
  method: string;
  /**
   * `Uint8Array<ArrayBuffer>`, deliberately NOT the wider
   * `Uint8Array<ArrayBufferLike>`: `undici`'s `BodyInit` does not accept a
   * `SharedArrayBuffer`-backed view, so the wider type fails to compile at
   * the `fetch` call below. Both `fs.readFile()` and `Buffer.from()`
   * already return exactly this narrower type, so no caller needs a cast.
   */
  body?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  /**
   * A NON-SECRET label identifying which key prefix the request targets
   * (e.g. `MEDIA_SMOKE_KEY_PREFIX`). This is the only caller-supplied
   * string allowed into a thrown error message, and it is still passed
   * through `redactSignedUrl` before being thrown.
   */
  keyPrefixLabel: string;
}

interface FfprobeJsonOutput {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{ codec_type?: string }>;
}

/**
 * Creates a fresh, empty throwaway directory under `os.tmpdir()`. Always
 * pair with {@link removeTempDir} in an `afterAll`.
 */
export async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), MEDIA_SMOKE_TEMP_DIR_PREFIX));
}

/**
 * Recursively removes `dir`. Idempotent by construction (`force: true`
 * swallows `ENOENT`), so calling it twice — or on a directory that was
 * never created because an earlier step threw — is safe and resolves
 * normally.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Produces a ~2 s, 64x64 MP4 containing BOTH a synthetic video stream
 * (`testsrc`) and a synthetic audio stream (`sine`) inside `dir`, and
 * returns its absolute path.
 *
 * Zero company content: both streams are generated by FFmpeg's `lavfi`
 * virtual input device from nothing but the arguments below. No file on
 * disk is read as an input.
 *
 * `-movflags +faststart` places the `moov` atom first, which is what a real
 * streaming upload would do and what makes the downloaded copy playable
 * without a full fetch.
 */
export async function generateSyntheticMp4(dir: string): Promise<string> {
  const outputPath = join(dir, `11k-synthetic-${randomUUID()}.mp4`);

  await execFileAsync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${SYNTHETIC_MP4_DURATION_SECONDS}:size=${SYNTHETIC_MP4_FRAME_SIZE}:rate=${SYNTHETIC_MP4_FRAME_RATE}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${SYNTHETIC_MP4_AUDIO_FREQUENCY_HZ}:duration=${SYNTHETIC_MP4_DURATION_SECONDS}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ],
    { maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES },
  );

  return outputPath;
}

/**
 * Runs `ffprobe` over `mediaPath` and returns the subset of its metadata
 * this slice asserts on. Used TWICE in the network spec: once before any
 * network call (so an unusable local fixture fails without touching R2) and
 * once on the downloaded copy (so a byte-identical-but-unplayable result
 * would still be caught).
 *
 * Rejects when `ffprobe` cannot parse the file at all (exit != 0, e.g. a
 * text file), and also when it parses but reports no format name or no
 * usable duration. The rejection message carries only the file's BASENAME
 * and `ffprobe`'s first stderr line with absolute paths stripped — enough
 * to debug ("moov atom not found" vs "Invalid data found"), without
 * pasting a full filesystem path into test output.
 */
export async function probeMp4(mediaPath: string): Promise<Mp4ProbeResult> {
  const name = basename(mediaPath);
  let stdout: string;

  try {
    ({ stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        mediaPath,
      ],
      { maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES },
    ));
  } catch (error) {
    throw new Error(
      `ffprobe could not read "${name}" as a media file: ` +
        describeFfprobeFailure(error, mediaPath),
    );
  }

  const parsed = JSON.parse(stdout) as FfprobeJsonOutput;
  const formatName = parsed.format?.format_name;
  const durationSeconds = Number(parsed.format?.duration);

  if (
    formatName === undefined ||
    formatName.length === 0 ||
    !Number.isFinite(durationSeconds)
  ) {
    throw new Error(
      `ffprobe parsed "${name}" but reported no usable container format ` +
        'or duration, so it is not a valid MP4.',
    );
  }

  const streams = parsed.streams ?? [];
  const { size } = await stat(mediaPath);

  return {
    formatName,
    durationSeconds,
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    sizeBytes: size,
  };
}

/**
 * `ffprobe` reports every MP4 under one shared QuickTime-family container
 * name (`mov,mp4,m4a,3gp,3g2,mj2`), so "is this an MP4?" is a membership
 * test over that comma-separated list rather than a string equality.
 */
export function isMp4FamilyFormat(formatName: string): boolean {
  return formatName
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .includes('mp4');
}

/**
 * Absolute (scheme-bearing) URLs. Matched greedily up to the first
 * whitespace, quote, angle bracket, backslash or closing bracket, so a URL
 * embedded in prose, in JSON, or inside an array literal is still caught
 * whole. Over-matching a trailing sentence period is harmless — this
 * function only ever over-redacts, never under-redacts.
 */
const ABSOLUTE_URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`<>\\)\]}]+/g;

/** Scheme-relative URLs (`//host/path?...`). */
const SCHEME_RELATIVE_URL_PATTERN = /(^|[\s"'`(<[{,])\/\/[^\s"'`<>\\)\]}]+/g;

/**
 * Residual SigV4 query parameters that survived without a surrounding URL
 * (e.g. someone logged a single extracted `X-Amz-Signature=...` pair). The
 * NAME is kept — it is not a secret and tells you what was redacted — but
 * the VALUE never survives. Deliberately matches every `X-Amz-*` name, not
 * just the seven this slice knows about, so a future SDK adding a new
 * signed parameter is covered by default.
 */
const SIGNED_QUERY_PARAM_PATTERN = /(X-Amz-[A-Za-z0-9-]+)=([^&\s"'`<>\\]*)/gi;

/** The SigV4 algorithm token, wherever it appears. */
const SIGV4_ALGORITHM_PATTERN = /AWS4-HMAC-SHA256/gi;

/**
 * A bare SigV4 signature: exactly 64 hex characters. Last line of defence
 * for a signature extracted away from both its URL and its parameter name.
 *
 * KNOWN, ACCEPTED over-redaction: this also rewrites any other 64-char hex
 * digest, including a SHA-256 checksum. That is fine here — nothing in this
 * slice routes a checksum through this function; the network spec compares
 * checksums with `expect(...).toBe(...)`, and Jest formats that diff itself
 * without calling `redactSignedUrl`.
 */
const SIGV4_SIGNATURE_HEX_PATTERN = /\b[a-f0-9]{64}\b/gi;

/**
 * Scrubs anything URL-shaped or signature-shaped out of `input` and
 * returns the result as a string.
 *
 * **This is the single most safety-critical function in slice 11K.** A
 * presigned R2 URL carries `X-Amz-Credential` (which embeds the access key
 * id) and `X-Amz-Signature` in its QUERY STRING, and its HOST embeds the
 * Cloudflare account id — so a signed URL must never reach an `expect()`
 * failure diff, console output, a thrown error, or a snapshot.
 *
 * The strategy is deliberately blunt: a whole URL is replaced wholesale
 * (scheme, host, path AND query), not surgically stripped parameter by
 * parameter, because the host and path are just as sensitive as the
 * signature. A bare URL with no query string at all is therefore redacted
 * too. Four further passes then catch fragments that appear without a
 * surrounding URL.
 *
 * Accepts `unknown` rather than `string` so an already-stringified array, a
 * raw array, an `Error`, or an arbitrary object can be passed straight in
 * without a caller first doing the (leak-prone) stringification itself.
 */
export function redactSignedUrl(input: unknown): string {
  return stringifyForRedaction(input)
    .replace(ABSOLUTE_URL_PATTERN, REDACTED_URL_PLACEHOLDER)
    .replace(
      SCHEME_RELATIVE_URL_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED_URL_PLACEHOLDER}`,
    )
    .replace(
      SIGNED_QUERY_PARAM_PATTERN,
      (_match, name: string) => `${name}=${REDACTED_VALUE_PLACEHOLDER}`,
    )
    .replace(SIGV4_ALGORITHM_PATTERN, REDACTED_VALUE_PLACEHOLDER)
    .replace(SIGV4_SIGNATURE_HEX_PATTERN, REDACTED_SIGNATURE_PLACEHOLDER);
}

/**
 * Performs a signed-URL HTTP request with the leakage guarantees this
 * slice is bound by:
 *
 * - `redirect: 'error'` — a redirect is rejected rather than followed, so a
 *   signed request can never be replayed against an unexpected host.
 * - On a non-2xx response the body is CANCELLED, never read. A failed
 *   signed request's body can echo the request back (S3-compatible error
 *   XML includes the resource), so not one byte of it is consumed.
 * - On a thrown transport error the caught error is never inspected,
 *   logged, or attached as `cause`: `undici` embeds the full request URL —
 *   query string and all — in its network errors.
 * - The re-thrown message therefore contains ONLY the HTTP method, the
 *   status code (when there is one) and the caller's non-secret key-prefix
 *   label, and is itself passed through {@link redactSignedUrl} as defence
 *   in depth.
 *
 * On success the `Response` is returned unread, so the caller can decide
 * how to consume it.
 */
export async function fetchSigned(
  url: string,
  init: SignedRequestInit,
): Promise<Response> {
  const { method, body, headers, keyPrefixLabel } = init;
  let response: Response;

  try {
    response = await fetch(url, {
      method,
      body,
      headers,
      redirect: 'error',
    });
  } catch {
    throw signedRequestError(method, undefined, keyPrefixLabel);
  }

  if (response.status < 200 || response.status >= 300) {
    await cancelBodyWithoutReading(response);
    throw signedRequestError(method, response.status, keyPrefixLabel);
  }

  return response;
}

function signedRequestError(
  method: string,
  status: number | undefined,
  keyPrefixLabel: string,
): Error {
  const statusPart =
    status === undefined
      ? 'no HTTP status (the request never completed)'
      : `HTTP status ${status}`;

  return new Error(
    redactSignedUrl(
      `Signed ${method} request failed with ${statusPart} for an object ` +
        `under key prefix "${keyPrefixLabel}". The signed URL, the request ` +
        'headers and the response body are all deliberately omitted: a ' +
        'presigned URL carries X-Amz-Credential and X-Amz-Signature in its ' +
        'query string.',
    ),
  );
}

/**
 * Releases the socket for a failed request WITHOUT reading a single byte of
 * its body. `cancel()` discards the stream; it never resolves to content.
 */
async function cancelBodyWithoutReading(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is not worth failing the run over,
    // and its error could itself carry the URL — so it is swallowed
    // without inspection.
  }
}

/** Best-effort, never-throwing stringification of an arbitrary value. */
function stringifyForRedaction(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof Error) {
    return `${input.name}: ${input.message}`;
  }

  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return '[unstringifiable value]';
  }
}

/**
 * Turns an `execFile` rejection into a short, path-free explanation. Only
 * the FIRST stderr line is kept, absolute occurrences of the probed path
 * are collapsed to its basename, and the result is passed through
 * `redactSignedUrl` for consistency with the rest of this module.
 */
function describeFfprobeFailure(error: unknown, mediaPath: string): string {
  const stderr =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';

  const firstLine = stderr.split('\n').find((line) => line.trim().length > 0);

  if (firstLine === undefined) {
    return 'ffprobe exited non-zero without any diagnostic output.';
  }

  return redactSignedUrl(
    firstLine.trim().split(mediaPath).join(basename(mediaPath)),
  );
}
