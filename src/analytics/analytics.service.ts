import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVENT_PROPERTY_ALLOWLIST,
  IngestEventsResponseDto,
  MAX_PROPERTY_STRING_LENGTH,
} from './analytics.types';
import { AnalyticsEventInputDto } from './dto/ingest-events.dto';

/**
 * Phase 11, work unit 11-B3: batch persistence for the self-hosted
 * analytics pipeline. Event names are validated at the DTO layer (unknown
 * names 400); property sanitization happens here so nothing outside the
 * documented allowlist — and no non-scalar value of any kind — can reach
 * the database, regardless of what a client sends.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(
    userId: string,
    events: readonly AnalyticsEventInputDto[],
  ): Promise<IngestEventsResponseDto> {
    const rows = events.map((event) => {
      // `@IsISO8601()` is shape-based and accepts calendar-invalid strings
      // like "2026-W01" that `new Date()` cannot parse — without this
      // re-check, such a value would surface as an unhandled 500 out of
      // Prisma instead of a clean validation 400 (review finding, cycle 1).
      const clientTimestamp = new Date(event.clientTimestamp);

      if (Number.isNaN(clientTimestamp.getTime())) {
        throw new BadRequestException(
          `events.clientTimestamp is not a parseable date: ${event.clientTimestamp}`,
        );
      }

      return {
        userId,
        eventName: event.eventName,
        properties: this.sanitizeProperties(event.eventName, event.properties),
        platform: event.platform,
        clientTimestamp,
      };
    });

    await this.prisma.analyticsEvent.createMany({ data: rows });

    return { accepted: rows.length };
  }

  /**
   * Keeps only allowlisted keys for the event, and only scalar values
   * (strings truncated to `MAX_PROPERTY_STRING_LENGTH`, finite numbers,
   * booleans). Objects, arrays, null, undefined, NaN/Infinity are dropped —
   * there is no legitimate nested payload in the documented schema, and
   * dropping beats persisting attacker-shaped structures.
   */
  private sanitizeProperties(
    eventName: string,
    properties: Record<string, unknown> | undefined,
  ): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};

    if (!properties) {
      return sanitized;
    }

    for (const key of EVENT_PROPERTY_ALLOWLIST[eventName] ?? []) {
      const value = properties[key];

      if (typeof value === 'string') {
        sanitized[key] = value.slice(0, MAX_PROPERTY_STRING_LENGTH);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        sanitized[key] = value;
      } else if (typeof value === 'boolean') {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
