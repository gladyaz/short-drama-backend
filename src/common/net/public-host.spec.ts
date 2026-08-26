import { isLoopbackHostname, isPrivateHostname } from './public-host';

/**
 * These predicates are now shared by three layers (boot-time env
 * validation, the pre-deploy preflight, and the post-deploy smoke test), so
 * they are tested directly rather than only through one caller. The range
 * BOUNDARIES matter most: `172.16`-`172.31` and `100.64`-`100.127` are the
 * two ranges where an off-by-one silently either blocks a legitimate public
 * address or lets a private one through.
 */
describe('isLoopbackHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'LocalHost', '127.0.0.1', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHostname(host)).toBe(true);
    },
  );

  it.each(['api.redpanda.app', 'example.com', '8.8.8.8', 'localhost.evil.com'])(
    'does not treat %s as loopback',
    (host) => {
      expect(isLoopbackHostname(host)).toBe(false);
    },
  );
});

describe('isPrivateHostname', () => {
  it.each([
    ['RFC1918 10/8', '10.0.0.1'],
    ['RFC1918 10/8 upper', '10.255.255.254'],
    ['RFC1918 192.168/16', '192.168.1.5'],
    ['RFC1918 172.16/12 lower bound', '172.16.0.1'],
    ['RFC1918 172.16/12 upper bound', '172.31.255.254'],
    ['RFC3927 link-local', '169.254.1.1'],
    ['CGNAT lower bound', '100.64.0.1'],
    ['CGNAT upper bound', '100.127.255.254'],
    ['mDNS .local', 'glady-mac.local'],
    ['mDNS .local uppercase', 'GLADY-MAC.LOCAL'],
  ])('treats %s (%s) as private', (_label, host) => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  it.each([
    ['public 172.15 (just below the range)', '172.15.0.1'],
    ['public 172.32 (just above the range)', '172.32.0.1'],
    ['public 100.63 (just below CGNAT)', '100.63.0.1'],
    ['public 100.128 (just above CGNAT)', '100.128.0.1'],
    ['public 11/8', '11.0.0.1'],
    ['public 192.167', '192.167.1.5'],
    ['public DNS name', 'api.redpanda.app'],
    // A hostname that merely CONTAINS a private-looking label is not
    // private — only a real dotted-quad in range, or a genuine `.local`
    // suffix, is. `10.0.0.1.evil.com` has five labels, not four.
    ['lookalike DNS name', '10.0.0.1.evil.com'],
    ['.local as an infix, not a suffix', 'my.local.example.com'],
  ])('does not treat %s (%s) as private', (_label, host) => {
    expect(isPrivateHostname(host)).toBe(false);
  });

  /**
   * Deliberately NOT rejected — documented in the module's doc comment.
   * Catching these would require DNS, and a boot-time validator that
   * resolves names fails for reasons unrelated to the config it judges.
   */
  it('does not attempt to judge a dotless internal hostname', () => {
    expect(isPrivateHostname('api')).toBe(false);
    expect(isLoopbackHostname('api')).toBe(false);
  });
});
