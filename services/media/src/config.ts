import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Media pipeline configuration.
 *
 * Everything is read from the environment with a working local default, so a
 * clone runs with no configuration at all, and nothing here is a secret: the
 * AES content keys live in the database, not in a variable.
 */
export interface MediaConfig {
  /** Root of every media file the pipeline writes. Absolute after resolution. */
  root: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Target segment length in seconds. */
  segmentSeconds: number;
  /** Wall-clock ceiling for one transcode, in milliseconds. */
  transcodeTimeoutMs: number;
}

/**
 * Anchor a relative MEDIA_ROOT to the repository root, not to the cwd.
 *
 * This is not cosmetic. The API is started from the repo root, the worker from
 * its own package, and the seed by pnpm from `packages/db` — so a plain
 * `resolve('./var/media')` gives three different directories. The symptom is
 * brutal to diagnose: seeding "succeeds", the transcode "succeeds", and every
 * lesson 404s because the API is looking somewhere the worker never wrote.
 *
 * The repo root is found by walking up for `pnpm-workspace.yaml`, which is the
 * one file guaranteed to sit at the top of this monorepo and nowhere else. An
 * absolute MEDIA_ROOT (what the containers set) is used as given.
 */
export function resolveMediaRoot(value: string, from: string = process.cwd()): string {
  if (isAbsolute(value)) return resolve(value);
  let directory = resolve(from);
  for (;;) {
    if (existsSync(resolve(directory, 'pnpm-workspace.yaml'))) {
      return resolve(directory, value);
    }
    const parent = dirname(directory);
    // Reached the filesystem root without finding the marker: fall back to the
    // cwd rather than throwing, so a single-package deploy still starts.
    if (parent === directory) return resolve(from, value);
    directory = parent;
  }
}

export function mediaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  return {
    root: resolveMediaRoot(env.MEDIA_ROOT ?? './var/media'),
    // The system binary by default. The overrides exist so a cloner whose
    // ffmpeg lives somewhere unusual does not have to patch code, and so CI can
    // point at a pinned build.
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
    segmentSeconds: positiveInt(env.HLS_SEGMENT_SECONDS, 4),
    transcodeTimeoutMs: positiveInt(env.TRANSCODE_TIMEOUT_MS, 15 * 60_000),
  };
}

/**
 * `Number('')` is 0, which would silently turn an empty variable into a zero
 * segment length and an instant transcode timeout. Blank means absent.
 */
function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export interface Rung {
  name: string;
  width: number;
  height: number;
  videoKbps: number;
  audioKbps: number;
}

/**
 * The bitrate ladder.
 *
 * Three rungs, 16:9, each roughly doubling in bitrate. Adaptive streaming needs
 * at least two to be adaptive at all; three is the smallest set that covers a
 * phone on cellular, a laptop on hotel wifi, and a desktop on fibre without
 * spending transcode time nobody watches.
 *
 * Widths are even numbers because libx264's chroma subsampling requires it: an
 * odd dimension fails the encode outright with a message that reads like a
 * filter bug.
 */
export const LADDER: readonly Rung[] = [
  { name: '360p', width: 640, height: 360, videoKbps: 800, audioKbps: 96 },
  { name: '540p', width: 960, height: 540, videoKbps: 1400, audioKbps: 128 },
  { name: '720p', width: 1280, height: 720, videoKbps: 2800, audioKbps: 128 },
] as const;

/**
 * Pick the rungs worth producing for a source of this height.
 *
 * Rungs above the source are dropped: upscaling spends CPU and bandwidth to
 * deliver a blurrier picture than the source at a higher bitrate, which is
 * strictly worse for everyone. A source smaller than the lowest rung still gets
 * that rung, because a ladder with no rungs is not a stream.
 */
export function ladderFor(sourceHeight: number): Rung[] {
  const usable = LADDER.filter((rung) => rung.height <= sourceHeight);
  return usable.length > 0 ? usable : [LADDER[0]!];
}
