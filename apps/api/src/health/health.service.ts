import { Inject, Injectable } from '@nestjs/common';
import { isAvailable, isWritable } from '@lms/media';
import type { Health } from '@lms/shared';
import { withTimeout } from '../common/with-timeout';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const CHECK_TIMEOUT_MS = 3_000;

/**
 * A health check that actually checks.
 *
 * Returning 200 while a dependency is unreachable is worse than no health check
 * at all: the monitor stays green through an outage, so the first report comes
 * from a user. Five probes, each one covering a way this stack can be up and
 * useless:
 *
 *   database      — obvious.
 *   redis         — rate limiting.
 *   ffmpeg        — no binary means no lesson will ever transcode. The failure
 *                   is otherwise silent: uploads succeed, jobs queue, and every
 *                   one of them fails a few seconds later where nobody looks.
 *   mediaStorage  — a read-only volume accepts uploads and loses them.
 *   worker        — no worker means jobs queue forever. Same silence.
 *
 * Each probe is bounded, so a hung dependency yields a fast 503 rather than a
 * request that never returns and reads to the monitor as a timeout.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<Health> {
    const [database, redis, ffmpeg, mediaStorage, worker] = await Promise.all([
      withTimeout(this.checkDatabase(), false, CHECK_TIMEOUT_MS),
      withTimeout(this.redis.ping(), false, CHECK_TIMEOUT_MS),
      withTimeout(isAvailable(this.config.media.ffmpegPath), false, CHECK_TIMEOUT_MS),
      withTimeout(isWritable(this.config.media.root), false, CHECK_TIMEOUT_MS),
      withTimeout(this.checkWorker(), false, CHECK_TIMEOUT_MS),
    ]);

    const checks = { database, redis, ffmpeg, mediaStorage, worker };
    return {
      status: Object.values(checks).every(Boolean) ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
      version: this.config.version,
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Has any worker checked in recently?
   *
   * Recency, not existence. A heartbeat row from a worker that died an hour ago
   * would otherwise report healthy forever, which is the exact failure this
   * probe exists to catch.
   */
  private async checkWorker(): Promise<boolean> {
    try {
      const latest = await this.prisma.workerHeartbeat.findFirst({
        orderBy: { seenAt: 'desc' },
        select: { seenAt: true },
      });
      if (!latest) return false;
      const ageSeconds = (Date.now() - latest.seenAt.getTime()) / 1000;
      return ageSeconds <= this.config.workerStaleSeconds;
    } catch {
      return false;
    }
  }
}
