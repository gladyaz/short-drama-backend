import { describe, expect, it } from 'vitest';
import {
  buildPreflightResponse,
  parseAllowedOrigins,
  resolveAllowedOrigin,
  withCors,
} from '../src/cors';

/**
 * Work unit "HLS WEB PLAYBACK" — unit coverage for the CORS layer's four
 * pure pieces. The end-to-end wiring (which responses actually carry these
 * headers, and the cache-poisoning guarantee) is asserted separately in
 * `index.spec.ts`; this file pins the rules themselves.
 */
describe('parseAllowedOrigins', () => {
  it('treats an absent or empty configuration as "no origins allowed"', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
    expect(parseAllowedOrigins(',,')).toEqual([]);
  });

  it('splits on commas and trims the surrounding whitespace an operator leaves behind', () => {
    expect(
      parseAllowedOrigins(' http://localhost:8082 , https://app.example.com ,'),
    ).toEqual(['http://localhost:8082', 'https://app.example.com']);
  });

  it('does not interpret a wildcard entry as anything special — it stays a literal that no real Origin can equal', () => {
    // A browser never sends `Origin: *`, so configuring it grants nothing.
    // This is the property that makes "never `*`" structural rather than a
    // rule someone has to remember: there is no code path that turns a
    // configured value into a wildcard response header.
    const allowed = parseAllowedOrigins('*');
    expect(allowed).toEqual(['*']);
    expect(resolveAllowedOrigin('https://evil.example.com', allowed)).toBeNull();
  });
});

describe('resolveAllowedOrigin', () => {
  const allowed = ['http://localhost:8082', 'https://app.example.com'];

  it('echoes back an exactly-matching origin', () => {
    expect(resolveAllowedOrigin('http://localhost:8082', allowed)).toBe(
      'http://localhost:8082',
    );
  });

  it('refuses an origin that is not listed', () => {
    expect(resolveAllowedOrigin('https://evil.example.com', allowed)).toBeNull();
  });

  it('refuses a near-miss: different scheme, different port, or a trailing slash', () => {
    expect(resolveAllowedOrigin('https://localhost:8082', allowed)).toBeNull();
    expect(resolveAllowedOrigin('http://localhost:8081', allowed)).toBeNull();
    expect(resolveAllowedOrigin('http://localhost:8082/', allowed)).toBeNull();
  });

  it('refuses a subdomain of an allowed origin (no suffix matching)', () => {
    expect(
      resolveAllowedOrigin('https://evil.app.example.com', allowed),
    ).toBeNull();
  });

  it('returns null when no allow-list is configured, whatever the origin', () => {
    expect(resolveAllowedOrigin('http://localhost:8082', [])).toBeNull();
  });

  it('returns null for a request with no Origin header (every native player)', () => {
    expect(resolveAllowedOrigin(null, allowed)).toBeNull();
  });
});

describe('withCors', () => {
  it('is a complete no-op when CORS is not configured — the same response object comes back untouched', () => {
    const original = new Response('body', { status: 200 });
    const result = withCors(original, null, false);

    expect(result).toBe(original);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(result.headers.get('Vary')).toBeNull();
  });

  it('adds the allow-origin and expose-headers for an allowed origin, preserving status and existing headers', () => {
    const original = new Response('body', {
      status: 206,
      headers: {
        'Content-Type': 'video/iso.segment',
        'Content-Range': 'bytes 0-9/100',
      },
    });
    const result = withCors(original, 'http://localhost:8082', true);

    expect(result.status).toBe(206);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:8082',
    );
    expect(result.headers.get('Access-Control-Expose-Headers')).toContain(
      'Content-Range',
    );
    expect(result.headers.get('Vary')).toBe('Origin');
    expect(result.headers.get('Content-Type')).toBe('video/iso.segment');
    expect(result.headers.get('Content-Range')).toBe('bytes 0-9/100');
  });

  it('still sets Vary: Origin — but no allow-origin — for a REFUSED origin, so a refusal is never reused for an allowed one', () => {
    const result = withCors(new Response('body'), null, true);

    expect(result.headers.get('Vary')).toBe('Origin');
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never mutates the response it was given (the copy handed to the cache stays CORS-free)', () => {
    const original = new Response('body', { status: 200 });
    withCors(original, 'http://localhost:8082', true);

    expect(original.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(original.headers.get('Vary')).toBeNull();
  });
});

describe('buildPreflightResponse', () => {
  it('returns null for a refused / unconfigured origin, so the caller falls through to normal handling', () => {
    expect(buildPreflightResponse(null)).toBeNull();
  });

  it('answers an allowed origin with 204 and the methods/headers a browser HLS engine needs', () => {
    const response = buildPreflightResponse('http://localhost:8082')!;

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:8082',
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'GET',
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
      'Range',
    );
    expect(response.headers.get('Access-Control-Max-Age')).toBe('3600');
    expect(response.headers.get('Vary')).toBe('Origin');
  });
});
