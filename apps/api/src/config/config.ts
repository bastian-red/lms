import { mediaConfigFromEnv, type MediaConfig } from '@lms/media';
import { notificationsConfigFromEnv, type NotificationsConfig } from '@lms/notifications';

export interface RateLimits {
  global: number;
  auth: number;
  /**
   * Media routes get their own budget. A ten-minute lesson at four-second
   * segments is ~150 requests plus a key fetch, and a shared office address
   * multiplies that by everyone watching. The production global budget would
   * refuse honest playback, so raising the global one to compensate is the
   * wrong fix: the media routes are separated instead.
   */
  media: number;
}

export interface AppConfig {
  port: number;
  redisUrl: string;
  authSecret: string;
  appBaseUrl: string;
  apiBaseUrl: string;
  media: MediaConfig;
  notifications: NotificationsConfig;
  rateLimits: RateLimits;
  /** How long a signed playback ticket is valid, in minutes. */
  ticketTtlMinutes: number;
  /** Largest accepted upload, in bytes. */
  maxUploadBytes: number;
  /** Coverage share needed before a video lesson counts as complete. */
  completionThreshold: number;
  /** /health reports degraded when no worker checked in for this long. */
  workerStaleSeconds: number;
  version: string;
}

/**
 * `Number('')` is 0, and an empty environment variable is a very ordinary thing
 * (a variable declared in a compose file with no value, a `.env` line left
 * blank). Parsing it as zero would set the upload limit to nothing and the
 * ticket TTL to already-expired, so blank is treated as absent.
 */
function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function ratioFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/**
 * Read at module load so the `@Throttle` decorators, which are evaluated at
 * class-definition time and cannot take a runtime value, still honour the
 * environment.
 */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    global: intFromEnv(env.RATE_LIMIT_GLOBAL, 120),
    auth: intFromEnv(env.RATE_LIMIT_AUTH, 5),
    media: intFromEnv(env.RATE_LIMIT_MEDIA, 2_000),
  };
}

export const RATE_LIMITS = rateLimitsFromEnv();

/**
 * Fails fast on a missing AUTH_SECRET rather than booting with a weak one.
 *
 * The same secret does three jobs: it signs the web app's service tokens, it
 * verifies them here, and it is the HMAC key for playback tickets. A mismatch
 * or a weak value is therefore a total auth failure plus a forgeable ticket,
 * and it must surface at boot rather than on the first request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authSecret = env.AUTH_SECRET;
  if (!authSecret || authSecret.length < 16) {
    throw new Error('AUTH_SECRET must be set (>= 16 chars).');
  }
  return {
    port: intFromEnv(env.PORT ?? env.API_PORT, 4000),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    authSecret,
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:3000',
    apiBaseUrl: env.API_BASE_URL ?? 'http://localhost:4000',
    media: mediaConfigFromEnv(env),
    notifications: notificationsConfigFromEnv(env),
    rateLimits: rateLimitsFromEnv(env),
    ticketTtlMinutes: intFromEnv(env.MEDIA_TICKET_TTL_MINUTES, 120),
    maxUploadBytes: intFromEnv(env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    completionThreshold: ratioFromEnv(env.COMPLETION_THRESHOLD, 0.9),
    workerStaleSeconds: intFromEnv(env.WORKER_STALE_SECONDS, 120),
    version: env.APP_VERSION ?? '0.1.0',
  };
}

export const CONFIG = Symbol('APP_CONFIG');
