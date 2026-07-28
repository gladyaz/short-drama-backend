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

  // Phase 12, work unit 12A-B4: redaction/secret-leak verification pass —
  // extends coverage from the fixed key list above to every secret/token
  // class named in the work unit's contract, plus a forward-looking generic
  // case so a NEW key (not in this codebase yet) is still caught.
  describe('Phase 12 (12A-B4) additional secret/token coverage', () => {
    it('redacts JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (env-style and camelCase config keys)', () => {
      const input = JSON.stringify({
        JWT_ACCESS_SECRET: 'access-signing-secret-do-not-log',
        JWT_REFRESH_SECRET: 'refresh-signing-secret-do-not-log',
      });
      const result = redactSensitiveText(input, undefined);

      expect(result).not.toContain('access-signing-secret-do-not-log');
      expect(result).not.toContain('refresh-signing-secret-do-not-log');
      expect(result).toContain('[REDACTED]');

      const camelResult = redactSensitiveText(
        JSON.stringify({
          jwtAccessSecret: 'camel-access-secret-value',
          jwtRefreshSecret: 'camel-refresh-secret-value',
        }),
        undefined,
      );
      expect(camelResult).not.toContain('camel-access-secret-value');
      expect(camelResult).not.toContain('camel-refresh-secret-value');
    });

    it("redacts AUTH_AUDIT_IP_HASH_SECRET (Phase 12, 12A-B3's dedicated IP-hashing secret)", () => {
      const result = redactSensitiveText(
        JSON.stringify({ authAuditIpHashSecret: 'ip-hash-secret-value-xyz' }),
        undefined,
      );
      expect(result).not.toContain('ip-hash-secret-value-xyz');
      expect(result).toContain('[REDACTED]');

      const envStyleResult = redactSensitiveText(
        'Missing config: AUTH_AUDIT_IP_HASH_SECRET: "another-secret-value-123"',
        undefined,
      );
      expect(envStyleResult).not.toContain('another-secret-value-123');
    });

    it('redacts DATABASE_URL and DATABASE_URL_TEST by key, AND strips embedded user:password@ credentials from a raw connection-string value with no key label', () => {
      const byKey = redactSensitiveText(
        JSON.stringify({
          DATABASE_URL:
            'postgresql://dbuser:dbpassword123@localhost:5433/short_drama_dev',
          DATABASE_URL_TEST:
            'postgresql://dbuser:dbpassword123@localhost:5433/short_drama_test',
        }),
        undefined,
      );
      expect(byKey).not.toContain('dbuser:dbpassword123');
      expect(byKey).toContain('[REDACTED]');

      // No preceding "databaseUrl"-shaped key at all — just the raw
      // connection string embedded in free text, e.g. a driver's own error
      // message. The URI-credential pattern must still strip it.
      const bareUri = redactSensitiveText(
        'connection failed: postgresql://dbuser:dbpassword123@localhost:5433/short_drama_dev is unreachable',
        undefined,
      );
      expect(bareUri).not.toContain('dbuser:dbpassword123');
      expect(bareUri).toContain(
        'postgresql://[REDACTED]@localhost:5433/short_drama_dev',
      );
    });

    it('redacts OBJECT_STORAGE_SECRET_ACCESS_KEY and OBJECT_STORAGE_ACCESS_KEY_ID (env-style and camelCase)', () => {
      const result = redactSensitiveText(
        JSON.stringify({
          OBJECT_STORAGE_SECRET_ACCESS_KEY: 'r2-secret-access-key-value',
          OBJECT_STORAGE_ACCESS_KEY_ID: 'r2-access-key-id-value',
        }),
        undefined,
      );
      expect(result).not.toContain('r2-secret-access-key-value');
      expect(result).not.toContain('r2-access-key-id-value');

      const camelResult = redactSensitiveText(
        JSON.stringify({
          secretAccessKey: 'camel-secret-access-key-value',
          accessKeyId: 'camel-access-key-id-value',
        }),
        undefined,
      );
      expect(camelResult).not.toContain('camel-secret-access-key-value');
      expect(camelResult).not.toContain('camel-access-key-id-value');
    });

    it('redacts a generic "authorization: Bearer <token>" header field regardless of surrounding structure', () => {
      const asHeaderObject = redactSensitiveText(
        JSON.stringify({
          headers: { authorization: 'Bearer some.jwt.value.here' },
        }),
        undefined,
      );
      expect(asHeaderObject).not.toContain('some.jwt.value.here');
    });

    // Forward-looking: work unit 12B-B3 (password reset) introduces a
    // `PasswordResetToken` model and will thread a raw `resetToken` value
    // through request/response DTOs and, transiently, dev-tooling output.
    // This key does NOT exist anywhere in this codebase yet — proving it is
    // already redacted demonstrates the pattern is genuinely keyword-based
    // (not a fixed list that 12B-B3 would need to remember to extend).
    it('redacts a future "resetToken" key that does not exist in this codebase yet (forward coverage for 12B-B3)', () => {
      const result = redactSensitiveText(
        JSON.stringify({
          userId: 'user-123',
          resetToken: 'not-yet-implemented-reset-token-value',
        }),
        undefined,
      );
      expect(result).not.toContain('not-yet-implemented-reset-token-value');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('"userId":"user-123"');
    });

    // Same forward-coverage guarantee, but for an arbitrary, never-seen
    // *Secret suffix — proves the guarantee generalizes beyond the one
    // concrete example above, per the work unit's "*Token, *Secret" ask.
    it('redacts an arbitrary never-seen "*Secret" suffix key (e.g. a hypothetical webhookSigningSecret)', () => {
      const result = redactSensitiveText(
        JSON.stringify({ webhookSigningSecret: 'wh-signing-secret-value' }),
        undefined,
      );
      expect(result).not.toContain('wh-signing-secret-value');
      expect(result).toContain('[REDACTED]');
    });

    it('does NOT redact ordinary non-sensitive keys that merely sit next to sensitive ones', () => {
      const result = redactSensitiveText(
        JSON.stringify({
          displayName: 'Jane Doe',
          email: 'jane@example.test',
          password: 'super-secret-pw',
        }),
        undefined,
      );
      expect(result).toContain('"displayName":"Jane Doe"');
      expect(result).toContain('"email":"jane@example.test"');
      expect(result).not.toContain('super-secret-pw');
    });
  });
});
