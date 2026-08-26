import {
  isAcceptableMediaStatus,
  judgePlaybackUrl,
} from './playback-url-guard';

/**
 * Work unit "PRODUCTION SMOKE TEST". The negative cases are the point: each
 * one is a URL shape this repo has actually produced from a developer
 * machine, and each would ship a broken app if it reached a store build.
 */
describe('judgePlaybackUrl', () => {
  it('accepts a public https media URL', () => {
    expect(judgePlaybackUrl('https://media.example.com/v/1.mp4').ok).toBe(true);
  });

  it('accepts a presigned URL carrying a query string', () => {
    expect(
      judgePlaybackUrl(
        'https://acct.r2.cloudflarestorage.com/bucket/admin-media/video-104-01/source?X-Amz-Signature=abc',
      ).ok,
    ).toBe(true);
  });

  it.each([null, undefined, '', '   '])(
    'rejects the absent URL %p',
    (value) => {
      expect(judgePlaybackUrl(value).rejection).toBe('missing');
    },
  );

  it('rejects the exact LAN URL this backend emits from a developer .env', () => {
    // Observed live: PUBLIC_BASE_URL=http://192.168.110.144:3000
    const verdict = judgePlaybackUrl(
      'http://192.168.110.144:3000/videos/video-104-01/stream',
    );

    expect(verdict.ok).toBe(false);
    // http is checked before host, so this is the reason reported first.
    expect(verdict.rejection).toBe('not_https');
  });

  it('rejects an https LAN address', () => {
    expect(judgePlaybackUrl('https://192.168.1.39/v.mp4').rejection).toBe(
      'private_lan_host',
    );
  });

  it.each([
    'https://10.0.0.5/v.mp4',
    'https://172.16.4.2/v.mp4',
    'https://172.31.255.1/v.mp4',
    'https://169.254.1.1/v.mp4',
    'https://100.64.0.1/v.mp4',
  ])('rejects the private range %s', (url) => {
    expect(judgePlaybackUrl(url).rejection).toBe('private_lan_host');
  });

  it('accepts a public address that merely LOOKS adjacent to a private range', () => {
    expect(judgePlaybackUrl('https://172.32.0.1/v.mp4').ok).toBe(true);
    expect(judgePlaybackUrl('https://11.0.0.1/v.mp4').ok).toBe(true);
  });

  it.each(['https://localhost/v.mp4', 'https://127.0.0.1/v.mp4'])(
    'rejects the loopback host %s',
    (url) => {
      expect(judgePlaybackUrl(url).rejection).toBe('loopback_host');
    },
  );

  it('rejects an mDNS .local hostname (a Mac advertising itself)', () => {
    expect(
      judgePlaybackUrl('https://gladyaz-macbook.local/v.mp4').rejection,
    ).toBe('private_lan_host');
  });

  it('rejects a URL carrying a developer filesystem path', () => {
    expect(
      judgePlaybackUrl(
        'https://cdn.example.com/Users/gladyaz/dracin-subsindo/a.mp4',
      ).rejection,
    ).toBe('contains_filesystem_path');
  });

  it('rejects a relative path, which is not a usable absolute media URL', () => {
    expect(judgePlaybackUrl('/videos/x/stream').rejection).toBe('unparseable');
  });
});

describe('isAcceptableMediaStatus', () => {
  it.each([200, 206])('accepts %i', (s) => {
    expect(isAcceptableMediaStatus(s)).toBe(true);
  });

  it.each([301, 403, 404, 416, 500])(
    'rejects %i — a linked object that does not serve',
    (s) => {
      expect(isAcceptableMediaStatus(s)).toBe(false);
    },
  );
});
