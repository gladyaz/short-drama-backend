import { redactSensitiveText } from './redact';

describe('redactSensitiveText', () => {
  it('replaces the storage root path wherever it appears', () => {
    const result = redactSensitiveText(
      'ENOENT: /srv/company-videos/Series 104/1_subtitled.mp4 not found',
      '/srv/company-videos',
    );

    expect(result).toBe(
      'ENOENT: [STORAGE_ROOT]/Series 104/1_subtitled.mp4 not found',
    );
    expect(result).not.toContain('/srv/company-videos');
  });

  it('redacts sensitive JSON field values (password, tokens, authorization)', () => {
    const input = JSON.stringify({
      email: 'user@example.test',
      password: 'super-secret-pw',
      refreshToken: 'aaaa1111bbbb2222',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.p.s',
    });

    const result = redactSensitiveText(input, undefined);

    expect(result).not.toContain('super-secret-pw');
    expect(result).not.toContain('aaaa1111bbbb2222');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(result).toContain('"email":"user@example.test"');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Prisma-style pretty-printed errors (unquoted key, double-quoted value)', () => {
    const result = redactSensitiveText(
      'Invalid `prisma.user.create()` invocation: { email: "u@example.test", passwordHash: "argon2id$m=65536$verysecrethash123" }',
      undefined,
    );

    expect(result).not.toContain('argon2id$m=65536$verysecrethash123');
    expect(result).toContain('passwordHash: "[REDACTED]"');
  });

  it('redacts util.inspect-style object dumps (unquoted key, single-quoted value)', () => {
    const result = redactSensitiveText(
      "{ password: 'super-secret-pw', refreshToken: 'aaaa1111bbbb2222' }",
      undefined,
    );

    expect(result).not.toContain('super-secret-pw');
    expect(result).not.toContain('aaaa1111bbbb2222');
  });

  it('redacts bare Bearer tokens outside JSON contexts (e.g. echoed headers)', () => {
    const result = redactSensitiveText(
      'request failed: Authorization: Bearer abc.def-ghi_jkl',
      undefined,
    );

    expect(result).not.toContain('abc.def-ghi_jkl');
    expect(result).toContain('Bearer [REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'GET /videos/feed 200 12ms userId=cuid123';
    expect(redactSensitiveText(text, '/srv/company-videos')).toBe(text);
  });

  it('does not treat a missing/empty storage root as redactable', () => {
    const text = 'error at /some/other/path';
    expect(redactSensitiveText(text, undefined)).toBe(text);
    expect(redactSensitiveText(text, '')).toBe(text);
  });
});
