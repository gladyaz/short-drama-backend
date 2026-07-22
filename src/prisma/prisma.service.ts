import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around the generated Prisma Client that hooks into the Nest
 * module lifecycle so the underlying database connection is opened once on
 * startup and closed cleanly on shutdown.
 *
 * This is an empty scaffold (Phase 8, work unit 8-B1): no domain models exist
 * on the Prisma schema yet, so this service currently only manages the
 * connection lifecycle. Domain-specific query helpers belong in later work
 * units once models (User, Session, Video, ...) are added.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to the database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Disconnected from the database');
  }
}
