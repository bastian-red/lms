import { Global, Module } from '@nestjs/common';
import { createChannel, type Channel } from '@lms/notifications';
import { CONFIG, loadConfig, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export const NOTIFICATIONS = Symbol('NOTIFICATIONS');

/**
 * Global infrastructure providers, built once at boot and shared by every
 * feature module.
 *
 * Constructed eagerly rather than lazily on first use: a misconfigured value
 * (a missing AUTH_SECRET, an unparseable Redis URL) then fails the boot instead
 * of failing the first request that happens to need it.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    {
      provide: RedisService,
      useFactory: (config: AppConfig) => new RedisService(config.redisUrl),
      inject: [CONFIG],
    },
    {
      provide: NOTIFICATIONS,
      useFactory: (config: AppConfig): Channel => createChannel(config.notifications),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, PrismaService, RedisService, NOTIFICATIONS],
})
export class CoreModule {}
