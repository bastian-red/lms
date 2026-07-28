import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@lms/db';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/**
 * The transaction-scoped client type.
 *
 * Every service method that participates in a transaction takes one of these
 * rather than reaching for the global client. That is what keeps the heartbeat's
 * read-merge-write genuinely atomic instead of autocommitting halfway through
 * and letting two concurrent beats each overwrite the other's merge.
 */
export type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
