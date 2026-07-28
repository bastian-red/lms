import { Prisma, type PrismaClient } from '@lms/db';

/**
 * Claiming work from the Postgres queue.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` is the whole mechanism. Inside a
 * transaction it locks the rows it returns and *skips* rows another transaction
 * already holds, so N workers polling the same table simultaneously each get a
 * different job with no coordination, no leader, and no broker.
 *
 * Why this rather than Redis or BullMQ, which the portfolio already uses
 * elsewhere:
 *
 *   The job and the thing it describes live in the same database. Enqueueing an
 *   upload writes the asset row and the job row in one transaction, so the state
 *   "asset exists, nothing will ever process it" is not reachable. With an
 *   external broker, a crash in the window between the two produces exactly
 *   that, and nothing in the system knows the asset is stranded. Project002 hit
 *   the general shape of this: its enqueue path swallowed errors, every order
 *   email silently never sent, and the suite stayed green.
 *
 * The cost is polling instead of push, which for a queue whose items take
 * minutes to process is not a cost at all.
 */

export interface ClaimedJob {
  jobId: string;
  assetId: string;
  attempts: number;
  maxAttempts: number;
  sourcePath: string;
  lessonId: string;
  /** Existing content key, when this is a re-transcode of the same asset. */
  encryptionKey: Buffer | null;
  encryptionIv: Buffer | null;
}

/**
 * Claim one job, or return null when there is nothing to do.
 *
 * Everything happens in one transaction: select-and-lock, mark RUNNING, mark the
 * asset PROCESSING. A worker that dies immediately after this leaves a RUNNING
 * job with a stale `lockedAt`, which `reclaimExpired` puts back.
 */
export async function claimJob(
  prisma: PrismaClient,
  workerId: string,
): Promise<ClaimedJob | null> {
  return prisma.$transaction(async (tx) => {
    // Raw SQL because Prisma has no way to express FOR UPDATE SKIP LOCKED, and
    // there is no substitute for it: without SKIP LOCKED two workers block on
    // each other and the queue processes serially; without FOR UPDATE they both
    // claim the same job.
    const rows = await tx.$queryRaw<{ id: string; asset_id: string; attempts: number; max_attempts: number }[]>(
      Prisma.sql`
        SELECT id, asset_id, attempts, max_attempts
        FROM transcode_jobs
        WHERE status = 'QUEUED' AND available_at <= now()
        ORDER BY available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );

    const row = rows[0];
    if (!row) return null;

    await tx.transcodeJob.update({
      where: { id: row.id },
      data: {
        status: 'RUNNING',
        attempts: { increment: 1 },
        lockedBy: workerId,
        lockedAt: new Date(),
      },
    });

    const asset = await tx.videoAsset.update({
      where: { id: row.asset_id },
      data: { status: 'PROCESSING', lastError: null },
      select: {
        id: true,
        lessonId: true,
        sourcePath: true,
        encryptionKey: true,
        encryptionIv: true,
      },
    });

    return {
      jobId: row.id,
      assetId: asset.id,
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
      sourcePath: asset.sourcePath,
      lessonId: asset.lessonId,
      encryptionKey: asset.encryptionKey ? Buffer.from(asset.encryptionKey) : null,
      encryptionIv: asset.encryptionIv ? Buffer.from(asset.encryptionIv) : null,
    };
  });
}

/**
 * Put jobs whose lease has expired back on the queue.
 *
 * This is what makes `kill -9` on a worker survivable. Without it, a job the
 * dead process had marked RUNNING stays RUNNING forever, its asset stays
 * PROCESSING forever, and the instructor's lesson never appears — with no error
 * anywhere, because nothing failed. It just stopped.
 *
 * `availableAt` is set to now rather than backed off: the job did not fail, it
 * was interrupted, and there is no reason to make the instructor wait longer for
 * someone else's crash. The attempt count was already incremented at claim time,
 * so a job that reliably kills its worker still runs out of attempts.
 */
export async function reclaimExpired(
  prisma: PrismaClient,
  leaseSeconds: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - leaseSeconds * 1000);
  const result = await prisma.transcodeJob.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
    data: { status: 'QUEUED', lockedBy: null, lockedAt: null, availableAt: new Date() },
  });
  return result.count;
}
