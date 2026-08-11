import { describe, expect, it } from 'vitest';
import { buildObjectKey, normalizeRelativePath } from '../src/path';
import vectors from './token-vectors.json';

describe('normalizeRelativePath (Slice 11Q, load-bearing path security)', () => {
  it('accepts a clean a/b/c.ext relative path unchanged', () => {
    expect(normalizeRelativePath('360p/index.m3u8')).toBe('360p/index.m3u8');
    expect(normalizeRelativePath('master.m3u8')).toBe('master.m3u8');
    expect(normalizeRelativePath('720p/seg_00001.m4s')).toBe(
      '720p/seg_00001.m4s',
    );
  });

  it('[TEST 7] rejects literal ".." traversal', () => {
    expect(normalizeRelativePath('../secret.mp4')).toBeNull();
    expect(normalizeRelativePath('360p/../../etc/passwd')).toBeNull();
    expect(normalizeRelativePath('..')).toBeNull();
  });

  it('rejects a bare "." component', () => {
    expect(normalizeRelativePath('./master.m3u8')).toBeNull();
    expect(normalizeRelativePath('360p/./index.m3u8')).toBeNull();
  });

  it('rejects any pure-dots component beyond "." and ".." (reviewer-recommended defense-in-depth, fix cycle 1)', () => {
    expect(normalizeRelativePath('.../master.m3u8')).toBeNull();
    expect(normalizeRelativePath('..../master.m3u8')).toBeNull();
    expect(normalizeRelativePath('360p/.../index.m3u8')).toBeNull();
  });

  it('rejects an empty component (double slash)', () => {
    expect(normalizeRelativePath('360p//index.m3u8')).toBeNull();
  });

  it('rejects a leading "/" (must be relative, never absolute)', () => {
    expect(normalizeRelativePath('/master.m3u8')).toBeNull();
    expect(normalizeRelativePath('//etc/passwd')).toBeNull();
  });

  it('rejects any backslash', () => {
    expect(normalizeRelativePath('360p\\index.m3u8')).toBeNull();
    expect(normalizeRelativePath('..\\..\\secret.mp4')).toBeNull();
  });

  it('rejects null bytes and control characters', () => {
    expect(normalizeRelativePath('master.m3u8\u0000')).toBeNull();
    expect(normalizeRelativePath('mas\u0001ter.m3u8')).toBeNull();
  });

  it('[TEST 8] rejects single percent-encoded traversal (%2e%2e%2f)', () => {
    expect(normalizeRelativePath('%2e%2e%2fsecret.mp4')).toBeNull();
    expect(normalizeRelativePath('%2E%2E%2Fsecret.mp4')).toBeNull(); // case-insensitive
  });

  it('[TEST 8] rejects an encoded leading slash (%2f)', () => {
    expect(normalizeRelativePath('%2fmaster.m3u8')).toBeNull();
  });

  it('[TEST 8] rejects an encoded backslash (%5c)', () => {
    expect(normalizeRelativePath('%5c%5csecret.mp4')).toBeNull();
  });

  it('[TEST 8] rejects DOUBLE-encoded traversal (%252e%252e%252f survives ONE decode as literal %2e%2e%2f)', () => {
    expect(normalizeRelativePath('%252e%252e%252fsecret.mp4')).toBeNull();
  });

  it('[TEST 8] rejects a Unicode fullwidth-solidus trick (NFC does not fold it to ASCII "/", and the character allowlist rejects it outright either way)', () => {
    // U+FF0F FULLWIDTH SOLIDUS
    expect(normalizeRelativePath('360p／..／secret.mp4')).toBeNull();
  });

  it('rejects a percent-decode failure (malformed escape)', () => {
    expect(normalizeRelativePath('%zz')).toBeNull();
    expect(normalizeRelativePath('100%')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeRelativePath('')).toBeNull();
  });

  it('rejects a path containing a raw space or other disallowed character', () => {
    expect(normalizeRelativePath('has space.mp4')).toBeNull();
    expect(normalizeRelativePath('semi;colon.mp4')).toBeNull();
  });

  it('accepts a percent-encoded but otherwise harmless character within the allowlist (e.g. an encoded dash decodes to a literal dash, still allowed)', () => {
    expect(normalizeRelativePath('seg%2D00001.m4s')).toBe('seg-00001.m4s');
  });
});

describe('buildObjectKey', () => {
  const prefix = 'admin-media/video-abc/hls/v1-a1-uuid/';

  it('concatenates prefix + relative path', () => {
    expect(buildObjectKey(prefix, 'master.m3u8')).toBe(
      'admin-media/video-abc/hls/v1-a1-uuid/master.m3u8',
    );
  });

  it('returns null for an empty prefix', () => {
    expect(buildObjectKey('', 'master.m3u8')).toBeNull();
  });

  it('returns null for an empty relative path', () => {
    expect(buildObjectKey(prefix, '')).toBeNull();
  });
});

describe('buildObjectKey structural media-scope confinement (Slice 11Q-A2 fix cycle 1, HIGH finding)', () => {
  /**
   * This is the GENUINE cross-media scope proof for this path-embedded-token
   * architecture. Per-request media isolation is not enforced by any
   * separate "does this token own this media" check at request time — it is
   * enforced structurally, once, right here: `buildObjectKey` only ever
   * concatenates the token's own verified prefix with an already-clean
   * relative path, and asserts the result `startsWith(prefix)`. Given that,
   * for ANY clean (allowlisted, traversal-free) `rel` — including one that
   * textually contains another media's id as an ordinary path segment —
   * the produced key can only ever land under THIS prefix, never under a
   * different media's prefix. A traversal-free, genuinely cross-media,
   * scope-distinct 403 cannot exist at the HTTP layer (see index.spec.ts
   * TEST 23's reframed docstring); this test is what actually backs that
   * claim, at the layer where the guarantee is real.
   */
  const prefixA = vectors.prefix;
  const prefixB = vectors.otherPrefix;

  const cleanRels = [
    'master.m3u8',
    '360p/index.m3u8',
    '360p/seg_00001.m4s',
    // Adversarial-but-clean: textually contains media B's real id as a
    // plain path segment. `normalizeRelativePath` would accept this rel
    // (it is traversal-free and allowlist-clean) — the question this test
    // answers is whether `buildObjectKey` can be tricked into resolving it
    // against media B's real prefix instead of media A's.
    `${vectors.otherMediaId}/master.m3u8`,
  ];

  it('for every clean relative path, the resulting key either starts with the authorized prefix or is null — never anything else', () => {
    for (const rel of cleanRels) {
      const key = buildObjectKey(prefixA, rel);
      // buildObjectKey never fails for a non-empty prefix + non-empty rel,
      // but the null branch is asserted too so this stays true even if a
      // future implementation legitimately rejects some input.
      expect(key === null || key.startsWith(prefixA)).toBe(true);
    }
  });

  it('the adversarial rel (embedding media B\'s id as a literal segment) resolves ONLY under media A\'s prefix — never under media B\'s real prefix, and never equals media B\'s real object key', () => {
    const adversarialRel = `${vectors.otherMediaId}/master.m3u8`;
    const key = buildObjectKey(prefixA, adversarialRel);

    // It must be confined to media A's own prefix...
    expect(key).toBe(`${prefixA}${vectors.otherMediaId}/master.m3u8`);
    expect(key?.startsWith(prefixA)).toBe(true);

    // ...and it must NEVER land under media B's real prefix, nor collide
    // with media B's actual object key (prefixB + "master.m3u8"). This is
    // the mutation-resistant half of the proof: if `buildObjectKey`'s
    // `startsWith` containment guard were ever removed AND a future
    // refactor changed key construction away from plain concatenation
    // (e.g. to something that could "resolve" the embedded segment against
    // a different base), this assertion — not just the concatenation
    // itself — is what would catch the prefix escape.
    expect(key?.startsWith(prefixB)).toBe(false);
    expect(key).not.toBe(`${prefixB}master.m3u8`);
  });
});
