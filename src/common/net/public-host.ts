/**
 * PRODUCTION HTTPS READINESS: the shared answer to "is this hostname
 * reachable from a phone on the public internet?"
 *
 * WHY THIS IS ITS OWN MODULE. Three unrelated layers need the exact same
 * judgement and must never drift apart:
 *
 *  - `src/config/env.validation.ts` refuses to BOOT a production process
 *    whose public URLs point at a developer machine;
 *  - `src/common/production-smoke/playback-url-guard.ts` refuses to PASS a
 *    deployed API whose `/videos/:id/playback` hands back such a URL;
 *  - `src/common/production-preflight/` refuses to PASS a candidate
 *    configuration before it is ever deployed.
 *
 * They are three different points on the same timeline (before deploy, at
 * boot, after deploy) guarding one failure: the API answers 200, the mobile
 * release preflight passes, and playback simply never starts on a real
 * device. Duplicating the ranges into each would let a rule be fixed in one
 * place and stay broken in the other two.
 *
 * Pure string predicates — no DNS resolution, no network access, no I/O.
 */

/**
 * Loopback names/addresses. `[::1]` is included alongside `::1` because
 * `URL#hostname` keeps the brackets on an IPv6 literal (`new URL('https://[::1]/').hostname`
 * is `'[::1]'`), while a raw hostname string passed in from elsewhere may not.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * RFC1918 private ranges plus RFC3927 link-local (169.254/16) and the
 * carrier-grade NAT range (100.64/10). `.local` mDNS names are caught too:
 * a Mac advertises itself that way, and `http://something.local:3000` is
 * exactly the shape a developer machine produces.
 *
 * Deliberately NOT a general "is this routable" test. A bare, dotless
 * hostname (`https://api`) and a private DNS name that resolves to an
 * internal address are both invisible here, because catching them would
 * require DNS — and a boot-time validator that resolves names would fail
 * for reasons unrelated to the configuration it is judging. This function
 * only ever rejects shapes that are unambiguously wrong on their face.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host.endsWith('.local')) {
    return true;
  }

  const octets = host.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) {
    return false;
  }

  const [a, b] = octets.map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}
