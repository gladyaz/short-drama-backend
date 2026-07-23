import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import {
  KNOWN_EVENT_NAMES,
  KNOWN_PLATFORMS,
  MAX_BATCH_SIZE,
} from '../analytics.types';

/**
 * One event in an ingestion batch (Phase 11, work unit 11-B3). An unknown
 * `eventName` fails validation outright (a plain 400, matching how every
 * other invalid body behaves in this API) rather than being silently
 * dropped — a client sending an unregistered event is a programming error
 * worth surfacing, whereas unknown property *keys* inside a known event
 * are merely stripped (see `AnalyticsService.sanitizeProperties`).
 */
export class AnalyticsEventInputDto {
  @IsIn(KNOWN_EVENT_NAMES)
  eventName!: string;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;

  @IsISO8601()
  clientTimestamp!: string;

  @IsIn(KNOWN_PLATFORMS)
  platform!: string;
}

export class IngestEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_SIZE)
  @ValidateNested({ each: true })
  @Type(() => AnalyticsEventInputDto)
  events!: AnalyticsEventInputDto[];
}
