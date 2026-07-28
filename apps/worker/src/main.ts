import { getPrisma } from '@lms/db';
import { isAvailable } from '@lms/media';
import { claimJob, reclaimExpired } from './claim';
import { workerConfigFromEnv } from './config';
import { processJob } from './process-job';

/**
 * The transcode worker.
 *
 * A poll loop, not a daemon framework. It claims one job at a time with
 * `FOR UPDATE SKIP LOCKED`, transcodes it, and writes the outcome. Running N of
 * these processes is the scaling story: they need no coordination because the
 * database provides it.
 *
 * One job at a time per process, deliberately. ffmpeg already saturates the
 * cores it is given, so a worker running three transcodes concurrently finishes
 * all three later than it would have finished them in sequence, while tripling
 * peak memory.
 */
async function main(): Promise<void> {
  const config = workerConfigFromEnv();
  const prisma = getPrisma();

  // Fail at startup rather than on the first job. A worker that boots happily
  // and then fails every transcode is the worst version of this: jobs burn
  // their attempts and land in FAILED with an error the instructor reads as
  // "my video is broken".
  for (const [name, binary] of [
    ['ffmpeg', config.media.ffmpegPath],
    ['ffprobe', config.media.ffprobePath],
  ] as const) {
    if (!(await isAvailable(binary))) {
      console.error(
        `[${config.id}] ${name} is not available at "${binary}". ` +
          `Install ffmpeg or set ${name.toUpperCase()}_PATH.`,
      );
      process.exit(1);
    }
  }

  console.log(`[${config.id}] started. media root: ${config.media.root}`);

  let running = true;
  let jobsDone = 0;
  let draining: Promise<unknown> | null = null;

  /**
   * Stop after the current job, not during it.
   *
   * A SIGTERM mid-transcode would leave a RUNNING job that only the lease
   * expiry recovers, which means a routine deploy costs an instructor half an
   * hour. Finishing the job first makes a restart free.
   */
  const stop = (signal: string): void => {
    if (!running) return;
    running = false;
    console.log(`[${config.id}] ${signal} received, finishing the current job then exiting`);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    try {
      // Before claiming: put back anything a dead worker was holding. Cheap
      // (one indexed UPDATE against a tiny set) and it is the only thing that
      // recovers a `kill -9`.
      const reclaimed = await reclaimExpired(prisma, config.leaseSeconds);
      if (reclaimed > 0) {
        console.log(`[${config.id}] reclaimed ${reclaimed} expired job(s)`);
      }

      const job = await claimJob(prisma, config.id);
      if (!job) {
        await heartbeat(prisma, config.id, jobsDone);
        await sleep(config.pollMs);
        continue;
      }

      console.log(`[${config.id}] claimed job ${job.jobId} (asset ${job.assetId})`);
      draining = processJob(prisma, config, job, (message) =>
        console.log(`[${config.id}] ${job.jobId}: ${message}`),
      );
      const outcome = await draining;
      draining = null;
      if (outcome === 'done') jobsDone += 1;

      await heartbeat(prisma, config.id, jobsDone);
    } catch (error) {
      // The loop itself must survive anything: a dropped connection, a
      // transient deadlock, a bad row. Sleeping before retrying stops a
      // persistent failure becoming a hot loop against the database.
      console.error(
        `[${config.id}] loop error: ${error instanceof Error ? error.message : String(error)}`,
      );
      await sleep(Math.max(config.pollMs, 5_000));
    }
  }

  if (draining) await draining;
  await prisma.$disconnect();
  console.log(`[${config.id}] stopped after ${jobsDone} job(s)`);
}

/**
 * Tell /health this worker is alive.
 *
 * Written every poll, whether or not there was work. A heartbeat that only
 * ticks on activity would make an idle-but-healthy worker indistinguishable
 * from a dead one, and the health check would go red on a quiet afternoon.
 */
async function heartbeat(
  prisma: ReturnType<typeof getPrisma>,
  id: string,
  jobsDone: number,
): Promise<void> {
  try {
    await prisma.workerHeartbeat.upsert({
      where: { id },
      update: { jobsDone },
      create: { id, jobsDone },
    });
  } catch {
    // A failed heartbeat is not a reason to stop working. /health will report
    // degraded, which is the correct signal, and the next tick may well succeed.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
