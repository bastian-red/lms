import { join } from 'node:path';
import { transcode, type MediaConfig, type RenditionResult } from '@lms/media';
import type { Prisma, PrismaClient } from '@lms/db';
import type { ClaimedJob } from './claim';
import { backoffSeconds, type WorkerConfig } from './config';

/**
 * Run one claimed job to a terminal state.
 *
 * Never throws. A worker whose loop can die on a bad upload is a worker that
 * stops processing every *other* instructor's video too, so every failure path
 * ends in a database write and a return.
 */
export async function processJob(
  prisma: PrismaClient,
  config: WorkerConfig,
  job: ClaimedJob,
  log: (message: string) => void = () => undefined,
): Promise<'done' | 'retry' | 'failed'> {
  const started = Date.now();
  try {
    if (!job.sourcePath) {
      // An asset row whose upload never landed. Retrying cannot help, so it
      // fails immediately rather than burning three attempts and 40 minutes of
      // backoff on a file that does not exist.
      return await fail(prisma, job, 'No source file was uploaded for this asset');
    }

    const result = await transcode({
      config: config.media,
      sourcePath: join(config.media.root, job.sourcePath),
      outputDir: join('assets', job.assetId),
      // Reuse the existing key on a re-transcode. A new key would be correct
      // too, but it would invalidate any segment a browser still has cached and
      // present as a mid-playback decode failure for anyone watching.
      key: job.encryptionKey ?? undefined,
      iv: job.encryptionIv ?? undefined,
      onProgress: log,
    });

    // The asset and the job move together. A committed asset with an
    // uncommitted job would be re-transcoded on the next poll; the reverse
    // would mark work done that produced nothing.
    await prisma.$transaction([
      prisma.videoAsset.update({
        where: { id: job.assetId },
        data: {
          status: 'READY',
          durationSeconds: result.probe.durationSeconds,
          width: result.probe.width,
          height: result.probe.height,
          outputDir: result.outputDir,
          renditions: toRenditionJson(result.renditions),
          encryptionKey: result.key,
          encryptionIv: result.iv,
          lastError: null,
        },
      }),
      prisma.transcodeJob.update({
        where: { id: job.jobId },
        data: { status: 'DONE', lockedBy: null, lockedAt: null, lastError: null },
      }),
    ]);

    log(
      `done in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
        `${result.renditions.map((r) => r.name).join(', ')}`,
    );
    return 'done';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempts >= job.maxAttempts) {
      return await fail(prisma, job, message);
    }

    // Retry with backoff. The asset goes back to PENDING rather than staying
    // PROCESSING, so the instructor's dashboard says "queued" — which is true —
    // instead of "processing" for a job that is currently doing nothing.
    const delay = backoffSeconds(job.attempts, config.backoffBaseSeconds);
    await prisma.$transaction([
      prisma.videoAsset.update({
        where: { id: job.assetId },
        data: { status: 'PENDING', lastError: message },
      }),
      prisma.transcodeJob.update({
        where: { id: job.jobId },
        data: {
          status: 'QUEUED',
          lockedBy: null,
          lockedAt: null,
          lastError: message,
          availableAt: new Date(Date.now() + delay * 1000),
        },
      }),
    ]);
    log(`attempt ${job.attempts}/${job.maxAttempts} failed, retrying in ${delay}s: ${message}`);
    return 'retry';
  }
}

/**
 * Terminal failure.
 *
 * The message is stored on the asset, not only on the job, because that is
 * where the instructor's UI reads it. A failure the instructor cannot see is a
 * lesson that silently never appears.
 */
async function fail(prisma: PrismaClient, job: ClaimedJob, message: string): Promise<'failed'> {
  await prisma.$transaction([
    prisma.videoAsset.update({
      where: { id: job.assetId },
      data: { status: 'FAILED', lastError: message },
    }),
    prisma.transcodeJob.update({
      where: { id: job.jobId },
      data: { status: 'FAILED', lockedBy: null, lockedAt: null, lastError: message },
    }),
  ]);
  return 'failed';
}

export function toRenditionJson(renditions: RenditionResult[]): Prisma.InputJsonValue {
  return renditions.map((rendition) => ({
    name: rendition.name,
    height: rendition.height,
    bitrateKbps: rendition.bitrateKbps,
    playlist: rendition.playlist,
    segmentCount: rendition.segmentCount,
  }));
}

export type { MediaConfig };
