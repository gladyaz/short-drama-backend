import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { readdir, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MEDIA_SMOKE_KEY_PREFIX,
  MEDIA_SMOKE_TEMP_DIR_PREFIX,
  REDACTED_SIGNATURE_PLACEHOLDER,
  REDACTED_URL_PLACEHOLDER,
  REDACTED_VALUE_PLACEHOLDER,
  SYNTHETIC_MP4_MAX_DURATION_SECONDS,
  SYNTHETIC_MP4_MIN_DURATION_SECONDS,
  createTempDir,
  fetchSigned,
  generateSyntheticMp4,
  isMp4FamilyFormat,
  probeMp4,
  redactSignedUrl,
  removeTempDir,
} from './storage-r2-media-smoke.helpers';

/**
 * Phase 11, slice 11K (work unit 11K-B2). The OFFLINE spec for the
 * media-smoke helpers. This file runs in a normal `npm test`:
 *
 * - **No network.** The only test that reaches `fetchSigned` stubs
 *   `globalThis.fetch` first, so no socket is ever opened.
 * - **No `.env`.** Nothing here imports `dotenv` or reads an
 *   `OBJECT_STORAGE_*` variable. The real-network spec
 *   (`storage-r2-media-smoke.spec.ts`) is the only file that loads `.env`,
 *   and only behind `RUN_R2_MEDIA_SMOKE=1`.
 * - **No company media.** Every media file here is a synthetic FFmpeg
 *   `testsrc`/`sine` clip inside a throwaway `os.tmpdir()` directory.
 *
 * The `ffmpeg`/`ffprobe`-dependent block auto-skips when those binaries are
 * not on `PATH`, mirroring the precedent in
 * `thumbnails/thumbnail.service.spec.ts`. That skip is VISIBLE in Jest's
 * output (`describe.skip`) and cannot produce a false-green network run:
 * the gated network spec probes its fixture BEFORE its first network call,
 * so a missing FFmpeg fails it loudly there instead.
 */

/**
 * Grep-able canary. If this string is ever found in test output, a
 * redaction path has regressed. It is a fake value that has never been a
 * real credential.
 */
const SENTINEL = 'S3NT1NEL-11K-MUST-NOT-LEAK';

/**
 * A synthetic host. `.example` is reserved by RFC 2606 and can never
 * resolve, and `synthetic-account-id` is obviously not a real Cloudflare
 * account id — no real endpoint, bucket or account fragment appears in
 * this repository.
 */
const SYNTHETIC_HOST = 'synthetic-account-id.r2.cloudflarestorage.example';

const SYNTHETIC_OBJECT_URL = `https://${SYNTHETIC_HOST}/synthetic-bucket/${MEDIA_SMOKE_KEY_PREFIX}11k-fake.mp4`;

/** A realistically shaped SigV4 presigned URL carrying the sentinel. */
const SYNTHETIC_SIGNED_URL = [
  SYNTHETIC_OBJECT_URL,
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256',
  `&X-Amz-Credential=${SENTINEL}-CREDENTIAL%2F20260731%2Fauto%2Fs3%2Faws4_request`,
  '&X-Amz-Date=20260731T000000Z',
  '&X-Amz-Expires=60',
  '&X-Amz-SignedHeaders=host',
  `&X-Amz-Security-Token=${SENTINEL}-TOKEN`,
  `&X-Amz-Signature=${SENTINEL}-SIGNATURE`,
].join('');

const SIGNED_QUERY_PARAM_NAMES = [
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'X-Amz-Security-Token',
  'X-Amz-Signature',
];

function isFfmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A `Response`-shaped stub whose every body-reading method is the SAME
 * spy, so a single `not.toHaveBeenCalled()` proves no body-read path was
 * taken.
 */
function createResponseStub(status: number): {
  response: Response;
  readBody: jest.Mock;
  cancelBody: jest.Mock;
} {
  const readBody = jest.fn();
  const cancelBody = jest.fn().mockResolvedValue(undefined);

  const response = {
    status,
    ok: status >= 200 && status < 300,
    body: { cancel: cancelBody },
    text: readBody,
    json: readBody,
    blob: readBody,
    bytes: readBody,
    formData: readBody,
    arrayBuffer: readBody,
  } as unknown as Response;

  return { response, readBody, cancelBody };
}

describe('storage-r2-media-smoke helpers — temp directory lifecycle', () => {
  it('creates a fresh, empty, prefixed directory under os.tmpdir()', async () => {
    const dir = await createTempDir();

    try {
      expect(dir.startsWith(join(tmpdir(), MEDIA_SMOKE_TEMP_DIR_PREFIX))).toBe(
        true,
      );
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('creates a distinct directory per call', async () => {
    const first = await createTempDir();
    const second = await createTempDir();

    try {
      expect(first).not.toBe(second);
    } finally {
      await removeTempDir(first);
      await removeTempDir(second);
    }
  });

  it('removes the directory and everything inside it', async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, 'child.txt'), 'disposable');

    await removeTempDir(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('is idempotent: removing an already-removed directory succeeds', async () => {
    const dir = await createTempDir();
    await removeTempDir(dir);

    await expect(removeTempDir(dir)).resolves.toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('succeeds on a directory that was never created at all', async () => {
    const neverCreated = join(
      tmpdir(),
      `${MEDIA_SMOKE_TEMP_DIR_PREFIX}${randomUUID()}`,
    );
    expect(existsSync(neverCreated)).toBe(false);

    await expect(removeTempDir(neverCreated)).resolves.toBeUndefined();
  });
});

describe('storage-r2-media-smoke helpers — isMp4FamilyFormat', () => {
  it('accepts the QuickTime-family name ffprobe reports for every MP4', () => {
    expect(isMp4FamilyFormat('mov,mp4,m4a,3gp,3g2,mj2')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isMp4FamilyFormat('MOV, MP4 , M4A')).toBe(true);
  });

  it('rejects a non-MP4 container and an empty format name', () => {
    expect(isMp4FamilyFormat('matroska,webm')).toBe(false);
    expect(isMp4FamilyFormat('mpegts')).toBe(false);
    expect(isMp4FamilyFormat('')).toBe(false);
  });
});

describe('storage-r2-media-smoke helpers — redactSignedUrl', () => {
  it('reduces a whole presigned URL to the placeholder, sentinel and all', () => {
    const redacted = redactSignedUrl(SYNTHETIC_SIGNED_URL);

    expect(redacted).toBe(REDACTED_URL_PLACEHOLDER);
    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).not.toContain(SYNTHETIC_HOST);
    expect(redacted).not.toContain('X-Amz-');
    expect(redacted).not.toContain('AWS4-HMAC');
  });

  it.each(SIGNED_QUERY_PARAM_NAMES)(
    'never lets a %s value survive inside a URL',
    (paramName) => {
      const url = `${SYNTHETIC_OBJECT_URL}?${paramName}=${SENTINEL}-${paramName}`;

      expect(redactSignedUrl(url)).not.toContain(SENTINEL);
    },
  );

  it.each(SIGNED_QUERY_PARAM_NAMES)(
    'never lets a bare %s pair survive without a surrounding URL',
    (paramName) => {
      const redacted = redactSignedUrl(`${paramName}=${SENTINEL}-${paramName}`);

      expect(redacted).not.toContain(SENTINEL);
      // The NAME is kept — it is not a secret and says what was removed.
      expect(redacted).toBe(`${paramName}=${REDACTED_VALUE_PLACEHOLDER}`);
    },
  );

  it('redacts a URL embedded in a longer sentence, keeping the prose', () => {
    const redacted = redactSignedUrl(
      `Upload failed for ${SYNTHETIC_SIGNED_URL} after 3 attempts.`,
    );

    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).not.toContain(SYNTHETIC_HOST);
    expect(redacted).toContain('Upload failed for');
    expect(redacted).toContain(REDACTED_URL_PLACEHOLDER);
  });

  it('redacts a URL inside a JSON-stringified array, keeping the safe entry', () => {
    const redacted = redactSignedUrl(
      JSON.stringify([SYNTHETIC_SIGNED_URL, 'harmless-sibling-value']),
    );

    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).not.toContain(SYNTHETIC_HOST);
    expect(redacted).toContain('harmless-sibling-value');
  });

  it('redacts a URL inside a raw array passed in unstringified', () => {
    const redacted = redactSignedUrl([SYNTHETIC_SIGNED_URL, SYNTHETIC_HOST]);

    expect(redacted).not.toContain(SENTINEL);
  });

  it('redacts a URL nested inside a plain object', () => {
    const redacted = redactSignedUrl({
      request: { method: 'PUT', url: SYNTHETIC_SIGNED_URL },
    });

    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).toContain('PUT');
  });

  it('redacts a bare URL that has no query string at all', () => {
    const bare = `https://${SENTINEL}.r2.cloudflarestorage.example/bucket/key.mp4`;

    const redacted = redactSignedUrl(bare);

    expect(redacted).toBe(REDACTED_URL_PLACEHOLDER);
    expect(redacted).not.toContain(SENTINEL);
  });

  it('redacts a scheme-relative URL', () => {
    const redacted = redactSignedUrl(
      `resource at //${SENTINEL}.example/bucket/key.mp4 was rejected`,
    );

    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).toContain('was rejected');
  });

  it('redacts the bare SigV4 algorithm token', () => {
    expect(redactSignedUrl('algorithm was AWS4-HMAC-SHA256')).not.toContain(
      'AWS4-HMAC',
    );
  });

  it('redacts a bare 64-character SigV4 signature digest', () => {
    const digest = 'a'.repeat(64);

    expect(redactSignedUrl(`signature ${digest} rejected`)).toBe(
      `signature ${REDACTED_SIGNATURE_PLACEHOLDER} rejected`,
    );
  });

  it('is idempotent — redacting an already-redacted string changes nothing', () => {
    const once = redactSignedUrl(
      `PUT ${SYNTHETIC_SIGNED_URL} -> 403 (X-Amz-Signature=${SENTINEL})`,
    );

    expect(redactSignedUrl(once)).toBe(once);
    expect(once).not.toContain(SENTINEL);
  });

  it('never throws and never leaks for non-string inputs', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      true,
      new Error(`boom at ${SYNTHETIC_SIGNED_URL}`),
      { nested: { deep: [SYNTHETIC_SIGNED_URL] } },
    ];

    for (const input of inputs) {
      const redacted = redactSignedUrl(input);

      expect(typeof redacted).toBe('string');
      expect(redacted).not.toContain(SENTINEL);
    }
  });

  it('survives a self-referential object without throwing', () => {
    const circular: Record<string, unknown> = { url: SYNTHETIC_SIGNED_URL };
    circular.self = circular;

    const redacted = redactSignedUrl(circular);

    expect(typeof redacted).toBe('string');
    expect(redacted).not.toContain(SENTINEL);
  });

  it('leaves a string with nothing sensitive in it untouched', () => {
    const safe = 'HEAD returned contentLength 22634 and contentType video/mp4';

    expect(redactSignedUrl(safe)).toBe(safe);
  });
});

describe('storage-r2-media-smoke helpers — fetchSigned', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects redirects and returns a 2xx response without reading it', async () => {
    const { response, readBody, cancelBody } = createResponseStub(200);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response);

    const result = await fetchSigned(SYNTHETIC_SIGNED_URL, {
      method: 'GET',
      keyPrefixLabel: MEDIA_SMOKE_KEY_PREFIX,
    });

    expect(result).toBe(response);
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('throws a URL-free, sentinel-free error on a non-2xx response and never reads the body', async () => {
    const { response, readBody, cancelBody } = createResponseStub(403);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    let caught: unknown;
    try {
      await fetchSigned(SYNTHETIC_SIGNED_URL, {
        method: 'PUT',
        body: Buffer.from('synthetic'),
        headers: { 'Content-Type': 'video/mp4' },
        keyPrefixLabel: MEDIA_SMOKE_KEY_PREFIX,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;

    // What MUST NOT be there.
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain(SYNTHETIC_HOST);
    expect(message).not.toContain('https://');
    expect(message).not.toContain('X-Amz-Signature=');
    expect(message).not.toContain('X-Amz-Credential=');

    // What MUST be there: method, status, key-prefix label. Nothing else.
    expect(message).toContain('PUT');
    expect(message).toContain('403');
    expect(message).toContain(MEDIA_SMOKE_KEY_PREFIX);

    // The response body was cancelled, never read.
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledTimes(1);

    // Nothing was attached that could carry the URL back out.
    expect((caught as Error).cause).toBeUndefined();
  });

  it('throws a URL-free, sentinel-free error when fetch itself rejects', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error(`fetch failed: connect ECONNREFUSED ${SYNTHETIC_SIGNED_URL}`),
      );

    let caught: unknown;
    try {
      await fetchSigned(SYNTHETIC_SIGNED_URL, {
        method: 'GET',
        keyPrefixLabel: MEDIA_SMOKE_KEY_PREFIX,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;

    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain(SYNTHETIC_HOST);
    expect(message).not.toContain('https://');
    expect(message).not.toContain('ECONNREFUSED');
    expect(message).toContain('GET');
    expect(message).toContain('never completed');
    expect(message).toContain(MEDIA_SMOKE_KEY_PREFIX);
    expect((caught as Error).cause).toBeUndefined();
  });

  it('redacts a key-prefix label that a caller wrongly filled with a URL', async () => {
    const { response } = createResponseStub(500);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    let caught: unknown;
    try {
      await fetchSigned(SYNTHETIC_SIGNED_URL, {
        method: 'GET',
        keyPrefixLabel: SYNTHETIC_SIGNED_URL,
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).not.toContain(SENTINEL);
    expect((caught as Error).message).toContain(REDACTED_URL_PLACEHOLDER);
  });
});

const maybeDescribe = isFfmpegAvailable() ? describe : describe.skip;

maybeDescribe(
  'storage-r2-media-smoke helpers — synthetic MP4 (real ffmpeg/ffprobe, auto-skips if unavailable)',
  () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await createTempDir();
    });

    afterAll(async () => {
      await removeTempDir(tempDir);
    });

    it('generates an MP4 with a video stream, an audio stream and a 1-3s duration', async () => {
      const mp4Path = await generateSyntheticMp4(tempDir);

      expect(mp4Path.startsWith(tempDir)).toBe(true);
      expect(mp4Path.endsWith('.mp4')).toBe(true);

      const probe = await probeMp4(mp4Path);

      expect(isMp4FamilyFormat(probe.formatName)).toBe(true);
      expect(probe.hasVideo).toBe(true);
      expect(probe.hasAudio).toBe(true);
      expect(probe.durationSeconds).toBeGreaterThanOrEqual(
        SYNTHETIC_MP4_MIN_DURATION_SECONDS,
      );
      expect(probe.durationSeconds).toBeLessThanOrEqual(
        SYNTHETIC_MP4_MAX_DURATION_SECONDS,
      );
      expect(probe.sizeBytes).toBeGreaterThan(0);
      expect(probe.sizeBytes).toBe((await stat(mp4Path)).size);
    }, 60000);

    it('writes a distinct file per call, so repeated calls never collide', async () => {
      const first = await generateSyntheticMp4(tempDir);
      const second = await generateSyntheticMp4(tempDir);

      expect(first).not.toBe(second);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
    }, 60000);

    it('rejects a plain text file that is not an MP4 at all', async () => {
      const textPath = join(tempDir, 'not-a-video.txt');
      await writeFile(textPath, 'this is definitely not an mp4 file\n');

      await expect(probeMp4(textPath)).rejects.toThrow(
        /ffprobe could not read "not-a-video\.txt" as a media file/,
      );
    }, 30000);

    it('rejects a zero-byte file whose .mp4 extension lies', async () => {
      const emptyPath = join(tempDir, 'empty.mp4');
      await writeFile(emptyPath, '');

      await expect(probeMp4(emptyPath)).rejects.toThrow(
        /ffprobe could not read "empty\.mp4" as a media file/,
      );
    }, 30000);

    it('keeps the absolute probed path out of its rejection message', async () => {
      const textPath = join(tempDir, 'path-free.txt');
      await writeFile(textPath, 'not media\n');

      let caught: unknown;
      try {
        await probeMp4(textPath);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(textPath);
      expect((caught as Error).message).not.toContain(tempDir);
      expect((caught as Error).message).toContain('path-free.txt');
    }, 30000);
  },
);
