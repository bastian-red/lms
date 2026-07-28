import { spawn } from 'node:child_process';

/**
 * The only place in the repo that runs ffmpeg.
 *
 * `spawn` with an argument array, not `exec` with a string and not
 * fluent-ffmpeg. Two reasons, both practical:
 *
 *  - An argument array never goes through a shell, so a filename with a space,
 *    a quote or a `;` in it is data rather than an injection. Media filenames
 *    come from uploads, so this is not hypothetical.
 *  - The exact argv is inspectable and loggable. When a transcode fails, the
 *    failure report is a command that can be pasted into a terminal verbatim,
 *    which a builder-pattern wrapper cannot give you.
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * Run a binary to completion with a hard timeout.
 *
 * The timeout is not optional. A malformed upload can put ffmpeg into a state
 * where it neither exits nor makes progress, and a worker blocked on that holds
 * its job lease forever, which stops the queue for every course.
 */
export function run(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const { timeoutMs = 15 * 60_000, cwd } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGKILL rather than SIGTERM: an ffmpeg wedged on a bad stream can
      // ignore a polite signal, and the point of the timeout is that it always
      // ends.
      child.kill('SIGKILL');
      rejectPromise(
        new FfmpegError(`${binary} timed out after ${timeoutMs}ms`, [binary, ...args], stderr, null),
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // ffmpeg is chatty on long jobs; keeping the whole log would grow without
      // bound. The tail is what a failure report needs.
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT here means the binary is missing, which is a deployment problem,
      // not a bad video. Saying so plainly saves a long debugging detour.
      rejectPromise(
        new FfmpegError(
          `${binary} could not be started: ${error.message}`,
          [binary, ...args],
          stderr,
          null,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export async function runOrThrow(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const result = await run(binary, args, options);
  if (result.code !== 0) {
    throw new FfmpegError(
      `${binary} exited with code ${result.code}`,
      [binary, ...args],
      result.stderr,
      result.code,
    );
  }
  return result;
}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string | null;
  /** Frames per second, from `r_frame_rate`. 25 when the container omits it. */
  fps: number;
}

/**
 * Parse `ffprobe -print_format json` output.
 *
 * Split out from the process call so it is unit-testable against captured
 * fixtures, which is the only way to cover the shapes that matter: a container
 * with no duration on the format, a video stream with no audio beside it, and
 * the string-typed numbers ffprobe emits.
 */
export function parseProbe(json: string): ProbeResult {
  const parsed = JSON.parse(json) as {
    format?: { duration?: string | number };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string | number;
      r_frame_rate?: string;
    }[];
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  // Duration comes from the container first and the video stream second. Some
  // containers (a raw stream, a partially written file) carry it in only one of
  // the two, and a missing duration means every completion calculation divides
  // by zero.
  const duration = toNumber(parsed.format?.duration) || toNumber(video?.duration) || 0;

  return {
    durationSeconds: duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: audio !== undefined,
    videoCodec: video?.codec_name ?? null,
    fps: parseFrameRate(video?.r_frame_rate),
  };
}

/**
 * ffprobe reports frame rate as an exact rational string ("30000/1001" for
 * 29.97fps), because the decimal form is not representable. The GOP length is
 * computed from this, so a wrong value puts keyframes off the segment
 * boundaries and makes rendition switching stutter.
 */
export function parseFrameRate(value: string | undefined): number {
  if (typeof value !== 'string') return DEFAULT_FPS;
  const [numerator, denominator] = value.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top <= 0) {
    // 0/0 is what ffprobe writes for a stream whose rate it could not
    // determine. Falling back beats producing a GOP length of NaN.
    return DEFAULT_FPS;
  }
  const fps = top / bottom;
  return fps > 0 && fps <= 480 ? fps : DEFAULT_FPS;
}

export const DEFAULT_FPS = 25;

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Probe a media file. Throws FfmpegError when the file is not decodable. */
export async function probe(
  ffprobePath: string,
  filePath: string,
  timeoutMs = 60_000,
): Promise<ProbeResult> {
  const result = await runOrThrow(
    ffprobePath,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      // Positional, and last: everything after `-i` is the input, so a filename
      // that starts with a dash cannot be read as a flag.
      '-i',
      filePath,
    ],
    { timeoutMs },
  );

  const probed = parseProbe(result.stdout);
  if (probed.width === 0 || probed.height === 0) {
    throw new FfmpegError(
      'No video stream found in the upload',
      [ffprobePath, filePath],
      result.stderr,
      0,
    );
  }
  if (probed.durationSeconds <= 0) {
    // A zero duration would make every lesson instantly "complete", because
    // coverage divides by it. Refusing the asset is the only safe answer.
    throw new FfmpegError(
      'Could not determine the duration of the upload',
      [ffprobePath, filePath],
      result.stderr,
      0,
    );
  }
  return probed;
}

/** True when the binary resolves and runs. Used by /health. */
export async function isAvailable(binary: string): Promise<boolean> {
  try {
    const result = await run(binary, ['-version'], { timeoutMs: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
