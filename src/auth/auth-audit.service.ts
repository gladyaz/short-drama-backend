import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { RootConfig } from '../config/configuration';
import { redactSensitiveText } from '../common/logging/redact';
import { PrismaService } from '../prisma/prisma.service';
import { hashIp, sanitizeUserAgent } from './auth-crypto';
import {
  AUTH_AUDIT_METADATA_ALLOWLIST,
  AuthAuditEventName,
  AuthAuditMetadataValue,
  EmitAuthAuditEventParams,
  MAX_METADATA_STRING_LENGTH,
} from './auth-audit.types';

/**
 * Phase 12, work unit 12A-B3: operational security audit logging (see
 * DECISIONS.md "Phase 12 ... approved..." entry, decision 6, and the
 * "Additional binding requirements" section). Writes to `AuthAuditEvent` —
 * deliberately SEPARATE from `AnalyticsEvent`/`AnalyticsService` (product
 * analytics), never merged.
 *
 * `emit` enforces every security invariant this phase requires before a row
 * is ever persisted:
 *   - `event` is restricted to the `AuthAuditEventName` allowlist union at
 *     the type level (see `auth-audit.types.ts`).
 *   - the raw client IP is NEVER stored — only an HMAC-SHA256 digest, keyed
 *     with `AUTH_AUDIT_IP_HASH_SECRET` (a secret dedicated to this purpose,
 *     distinct from the JWT access/refresh signing secrets).
 *   - `userAgent` is truncated to `MAX_USER_AGENT_LENGTH` and stripped of
 *     control characters before storage — never persisted verbatim/
 *     unbounded.
 *   - `metadata` is filtered down to the per-event allowlist in
 *     `AUTH_AUDIT_METADATA_ALLOWLIST`, and only scalar values survive
 *     (mirroring `AnalyticsService.sanitizeProperties`'s existing pattern) —
 *     no token, password, secret, raw email, or raw IP can reach this table
 *     regardless of what a caller passes in.
 *
 * The IP-hashing and user-agent-sanitization primitives themselves live in
 * `./auth-crypto.ts` (Phase 12, work unit 12B-B2), not here — `AuthService`'s
 * session-writing path (`Session.ipHash`/`Session.userAgent`) needs the
 * EXACT same two primitives, and duplicating either would risk the audit
 * log and the session table silently disagreeing on how the same raw IP/
 * user-agent value gets hashed or sanitized.
 *
 * Emission is deliberately BEST-EFFORT: a failure to write the audit row
 * (e.g. a transient DB error) is caught and logged through the existing
 * redaction-safe logger, never rethrown — an audit-logging outage must never
 * break the login/register/refresh flow it is observing. The happy path
 * still reliably awaits and records the row (this is not "fire and forget";
 * callers `await emit(...)`, they just never see it throw).
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger(AuthAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<RootConfig>,
  ) {}

  async emit(
    event: AuthAuditEventName,
    params: EmitAuthAuditEventParams = {},
  ): Promise<void> {
    try {
      const authConfig = this.configService.get('auth', { infer: true })!;
      const ipHash =
        params.ip !== undefined
          ? hashIp(params.ip, authConfig.authAuditIpHashSecret)
          : undefined;
      const userAgent =
        params.userAgent !== undefined
          ? sanitizeUserAgent(params.userAgent)
          : undefined;
      const metadata = sanitizeMetadata(event, params.metadata);

      await this.prisma.authAuditEvent.create({
        data: {
          userId: params.userId ?? null,
          event,
          ipHash: ipHash ?? null,
          userAgent: userAgent ?? null,
          // Prisma's typed client requires `Prisma.JsonNull` (not a plain
          // `null` literal) to explicitly persist SQL NULL into a nullable
          // Json column — a plain `null` is ambiguous between "no value"
          // and "the JSON value `null`". Omitting the key entirely also
          // works (defaults to NULL, since the column has no `@default`),
          // but being explicit here documents the "empty metadata" case is
          // intentional, not an oversight.
          metadata:
            Object.keys(metadata).length > 0 ? metadata : Prisma.JsonNull,
        },
      });
    } catch (error) {
      // Best-effort per this unit's contract: never let an audit-write
      // failure break the auth flow that called us. `redactSensitiveText`
      // guards against a Prisma error's message/stack ever surfacing a
      // secret (matching every other error-logging call site in this repo).
      const detail =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(
        redactSensitiveText(
          `Failed to write AuthAuditEvent for "${event}": ${detail}`,
        ),
      );
    }
  }
}

/**
 * Keeps only the metadata keys allowlisted for this specific event, and only
 * scalar values (strings truncated to `MAX_METADATA_STRING_LENGTH`, finite
 * numbers, booleans) — objects, arrays, null, undefined, NaN/Infinity are all
 * dropped. Mirrors `AnalyticsService.sanitizeProperties` exactly, applied to
 * a separate, security-purpose allowlist.
 */
function sanitizeMetadata(
  event: AuthAuditEventName,
  metadata: Record<string, unknown> | undefined,
): Record<string, AuthAuditMetadataValue> {
  const sanitized: Record<string, AuthAuditMetadataValue> = {};

  if (!metadata) {
    return sanitized;
  }

  for (const key of AUTH_AUDIT_METADATA_ALLOWLIST[event]) {
    const value = metadata[key];

    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_METADATA_STRING_LENGTH);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
