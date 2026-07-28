import { mediaConfigFromEnv, type MediaConfig } from '@lms/media';

export interface WorkerConfig {
  /** Identifier written into the job lease and the heartbeat row. */
  id: string;
  /** How often to look for claimable work, in milliseconds. */
  pollMs: number;
  /**
   * How long a claim is honoured. A job whose lock is older than this is
   * reclaimable by another worker, which is what stops a killed process from
   * stranding an asset in PROCESSING forever.
   */
  leaseSeconds: number;
  media: MediaConfig;
  /** Attempts before a job is given up on. */
  maxAttempts: number;
  /** Base for the exponential backoff between attempts, in seconds. */
  backoffBaseSeconds: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function workerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    // The hostname is a good default in a container, where it is the container
    // id, and merely adequate on a laptop. Either way it is only ever an
    // identifier, never an authorisation.
    id: env.WORKER_ID?.trim() || `worker-${process.pid}`,
    pollMs: intFromEnv(env.WORKER_POLL_MS, 2_000),
    leaseSeconds: intFromEnv(env.JOB_LEASE_SECONDS, 1_800),
    media: mediaConfigFromEnv(env),
    maxAttempts: intFromEnv(env.TRANSCODE_MAX_ATTEMPTS, 3),
    backoffBaseSeconds: intFromEnv(env.TRANSCODE_BACKOFF_SECONDS, 15),
  };
}

/**
 * Exponential backoff, capped.
 *
 * Uncapped doubling reaches days by the fifth attempt, which for a video an
 * instructor is waiting on is indistinguishable from never. Capped at ten
 * minutes: long enough to ride out a transient disk or CPU problem, short
 * enough that a fixed cause is retried while someone is still watching.
 */
export function backoffSeconds(attempts: number, base: number): number {
  const seconds = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(seconds, 600);
}
