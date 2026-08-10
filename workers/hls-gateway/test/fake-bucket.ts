import type { MediaBucket, MediaObject, MediaObjectRangeRequest } from '../src/env.types';

/**
 * Minimal, deterministic, in-memory stand-in for a private R2 bucket —
 * used by every handler-level test in `index.spec.ts` so this whole
 * package never needs miniflare or a real R2 connection. Mirrors real R2
 * `.get()` range semantics closely enough for this gateway's purposes:
 * `{offset, length}`, `{offset}` (open-ended), and `{suffix}` are all
 * resolved against the stored object's REAL size, clamped to valid bounds.
 */
export class FakeMediaBucket implements MediaBucket {
  private readonly objects = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async get(
    key: string,
    options?: { range?: MediaObjectRangeRequest },
  ): Promise<MediaObject | null> {
    const bytes = this.objects.get(key);
    if (!bytes) {
      return null;
    }

    const size = bytes.length;
    const range = options?.range;

    if (!range) {
      return { body: toReadableStream(bytes), size };
    }

    const resolved = resolveRange(range, size);
    const slice = bytes.slice(resolved.offset, resolved.offset + resolved.length);
    return { body: toReadableStream(slice), size, range: resolved };
  }
}

function resolveRange(
  range: MediaObjectRangeRequest,
  size: number,
): { offset: number; length: number } {
  if ('suffix' in range) {
    const length = Math.min(range.suffix, size);
    return { offset: Math.max(size - length, 0), length };
  }

  const offset = Math.min(Math.max(range.offset, 0), size);
  const length =
    range.length !== undefined
      ? Math.min(range.length, size - offset)
      : size - offset;

  return { offset, length: Math.max(length, 0) };
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}
