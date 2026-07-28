import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ladderFor, type MediaConfig, type Rung } from './config';
import { FfmpegError, probe, runOrThrow, type ProbeResult } from './ffmpeg';
import { KEY_URI_PLACEHOLDER, parseMediaPlaylist } from './playlist';

/**
 * The transcode step: one source file in, an AES-128 encrypted HLS ladder out.
 *
 * The property this file exists to guarantee is that **nothing on disk is
 * playable**. ffmpeg encrypts every segment with a key it is handed at encode
 * time, that key is written to a temporary file that is deleted in a `finally`,
 * and the URI baked into the playlist is a placeholder the API rewrites per
 * request. Copy the whole media directory to a laptop and you have a pile of
 * ciphertext.
 *
 * Verified rather than asserted: `assertEncrypted` reads the first byte of a
 * produced segment and refuses to report success if it is 0x47, the MPEG-TS
 * sync byte. A silent fallback to plaintext (an ffmpeg build without the
 * option, a typo in the key-info file) would otherwise ship an unprotected
 * course looking exactly like a protected one.
 */

export interface RenditionResult {
  name: string;
  height: number;
  bitrateKbps: number;
  /** Media playlist path relative to the asset's output directory. */
  playlist: string;
  segmentCount: number;
  /** Sum of the #EXTINF values, used to cross-check the transcode. */
  playlistDurationSeconds: number;
}

export interface TranscodeResult {
  outputDir: string;
  masterPlaylist: string;
  renditions: RenditionResult[];
  probe: ProbeResult;
  key: Buffer;
  iv: Buffer;
}

export const MASTER_PLAYLIST = 'master.m3u8';
export const AES_KEY_BYTES = 16;

/**
 * Tolerance between the probed source duration and the sum of the produced
 * segment durations.
 *
 * A transcode that dies halfway leaves a valid-looking playlist covering half
 * the lesson, and every completion calculation downstream would then be against
 * the wrong denominator. 2.5% plus one segment absorbs the honest difference
 * (keyframe alignment shifts segment boundaries) while still catching a
 * truncation.
 */
export const DURATION_TOLERANCE_RATIO = 0.025;

export interface TranscodeOptions {
  config: MediaConfig;
  /** Absolute path of the uploaded source. */
  sourcePath: string;
  /** Directory to write into, relative to `config.root`. */
  outputDir: string;
  /** Reuse an existing content key (a re-transcode of the same asset). */
  key?: Buffer;
  iv?: Buffer;
  onProgress?: (message: string) => void;
}

/**
 * Build the encrypted ladder.
 *
 * One ffmpeg invocation per rung rather than one invocation with a filter graph
 * and `var_stream_map`. The single-invocation form is faster on paper, but a
 * failure in it loses every rendition and reports one merged stderr for all of
 * them; per-rung, a 720p that fails on a weird source still leaves a playable
 * 360p and a failure message that names which rung broke.
 */
export async function transcode(options: TranscodeOptions): Promise<TranscodeResult> {
  const { config, sourcePath, outputDir, onProgress } = options;

  const probed = await probe(config.ffprobePath, sourcePath);
  onProgress?.(
    `probe: ${probed.width}x${probed.height}, ${probed.durationSeconds.toFixed(2)}s, audio=${probed.hasAudio}`,
  );

  const absoluteOutput = join(config.root, outputDir);
  // A re-transcode must not merge with the previous attempt's segments: stale
  // files from a taller ladder would stay referenced by nothing and stale ones
  // from the same rung would be served alongside the new key, which decrypts to
  // noise.
  await rm(absoluteOutput, { recursive: true, force: true });
  await mkdir(absoluteOutput, { recursive: true });

  const key = options.key ?? randomBytes(AES_KEY_BYTES);
  const iv = options.iv ?? randomBytes(AES_KEY_BYTES);
  if (key.length !== AES_KEY_BYTES || iv.length !== AES_KEY_BYTES) {
    throw new Error(`AES-128 needs a ${AES_KEY_BYTES}-byte key and IV`);
  }

  const rungs = ladderFor(probed.height);
  const renditions: RenditionResult[] = [];

  // The key-info file is how ffmpeg is told what to encrypt with. It is three
  // lines: the URI to write into the playlist, the path to read the key bytes
  // from, and the IV in hex.
  //
  // Both files go in a private temp directory, never in the media root. Putting
  // them beside the segments would mean the one directory an operator is most
  // likely to copy, back up or mount read-only into another container contains
  // both the ciphertext and the key that opens it, which defeats the entire
  // exercise. The `finally` removes the directory whether the encode succeeded
  // or threw.
  const secretsDir = await mkdtemp(join(tmpdir(), 'lms-hls-'));
  const keyInfoPath = join(secretsDir, 'keyinfo');
  const keyFilePath = join(secretsDir, 'key.bin');

  try {
    // 0600: on a shared machine the default 0644 would let any local account
    // read the content key straight off disk while the encode runs.
    await writeFile(keyFilePath, key, { mode: 0o600 });
    await writeFile(
      keyInfoPath,
      `${KEY_URI_PLACEHOLDER}\n${keyFilePath}\n${iv.toString('hex')}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    for (const rung of rungs) {
      onProgress?.(`encoding ${rung.name}`);
      renditions.push(
        await encodeRung({
          config,
          sourcePath,
          absoluteOutput,
          keyInfoPath,
          rung,
          hasAudio: probed.hasAudio,
          fps: probed.fps,
        }),
      );
    }
  } finally {
    // `force: true` so a failure before the files were written does not mask
    // the real error with an ENOENT from the cleanup.
    await rm(secretsDir, { recursive: true, force: true });
  }

  await assertEncrypted(absoluteOutput, renditions);
  assertDurationsMatch(probed.durationSeconds, renditions, config.segmentSeconds);

  const master = buildMasterPlaylist(renditions, rungs);
  await writeFile(join(absoluteOutput, MASTER_PLAYLIST), master, 'utf8');

  return {
    outputDir,
    masterPlaylist: MASTER_PLAYLIST,
    renditions,
    probe: probed,
    key,
    iv,
  };
}

interface EncodeRungOptions {
  config: MediaConfig;
  sourcePath: string;
  absoluteOutput: string;
  keyInfoPath: string;
  rung: Rung;
  hasAudio: boolean;
  fps: number;
}

async function encodeRung(options: EncodeRungOptions): Promise<RenditionResult> {
  const { config, sourcePath, absoluteOutput, keyInfoPath, rung, hasAudio, fps } = options;
  const dir = join(absoluteOutput, rung.name);
  await mkdir(dir, { recursive: true });

  const playlistName = 'index.m3u8';
  const args = [
    '-nostdin',
    '-y',
    '-i',
    sourcePath,
    // Scale to the rung's height, keep the aspect, and force even dimensions.
    // `-2` computes the width from the aspect and rounds it to a multiple of 2,
    // which libx264 requires; a hardcoded width would letterbox 4:3 sources.
    '-vf',
    `scale=-2:${rung.height}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    // Constrained bitrate rather than CRF. Adaptive streaming picks a rendition
    // by its advertised bitrate, so the advertised number has to be one the
    // stream actually respects.
    '-b:v',
    `${rung.videoKbps}k`,
    '-maxrate',
    `${Math.round(rung.videoKbps * 1.07)}k`,
    '-bufsize',
    `${rung.videoKbps * 2}k`,
    // A keyframe exactly every segment, and nowhere else. Without both flags
    // ffmpeg places keyframes on scene changes, segments end up different
    // lengths across rungs, and a player switching rendition mid-stream stalls
    // or skips because the switch point does not line up.
    '-g',
    String(gopLength(fps, config.segmentSeconds)),
    '-keyint_min',
    String(gopLength(fps, config.segmentSeconds)),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${config.segmentSeconds})`,
  ];

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', `${rung.audioKbps}k`, '-ac', '2');
  } else {
    // A source with no audio track: say so explicitly rather than letting the
    // muxer guess. An HLS variant that advertises audio it does not have makes
    // some players wait forever for a stream that never arrives.
    args.push('-an');
  }

  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(config.segmentSeconds),
    // 0 = keep every segment in the playlist. This is VOD, not live; a rolling
    // window would make the back half of the lesson unreachable.
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    join(dir, 'seg%05d.ts'),
    // The encryption. Without this line every segment on disk is a playable
    // MPEG-TS file and the entire access-control story is decoration.
    '-hls_key_info_file',
    keyInfoPath,
    join(dir, playlistName),
  );

  await runOrThrow(config.ffmpegPath, args, { timeoutMs: config.transcodeTimeoutMs });

  const playlistPath = join(dir, playlistName);
  const playlistText = await readFile(playlistPath, 'utf8');
  const parsed = parseMediaPlaylist(playlistText);

  if (parsed.segments.length === 0) {
    throw new FfmpegError(
      `${rung.name} produced a playlist with no segments`,
      [config.ffmpegPath, ...args],
      playlistText,
      0,
    );
  }
  if (parsed.keyUri === null) {
    // ffmpeg accepted the key-info file but wrote no #EXT-X-KEY. Every segment
    // is plaintext. Failing here is the difference between an unencrypted
    // course being caught in CI and being caught by a customer.
    throw new FfmpegError(
      `${rung.name} was written without an #EXT-X-KEY line`,
      [config.ffmpegPath, ...args],
      playlistText,
      0,
    );
  }

  return {
    name: rung.name,
    height: rung.height,
    bitrateKbps: rung.videoKbps + (hasAudio ? rung.audioKbps : 0),
    playlist: `${rung.name}/${playlistName}`,
    segmentCount: parsed.segments.length,
    playlistDurationSeconds: parsed.totalDuration,
  };
}

/**
 * Frames per segment, which is what `-g` wants.
 *
 * Derived from the probed frame rate rather than assumed. A hardcoded 25 turns
 * a 60fps screencast into a 2.4-fold overshoot: keyframes land mid-segment,
 * segment boundaries stop lining up between rungs, and switching renditions
 * mid-playback stutters. Rounded, and floored at 1 so a slideshow-rate source
 * cannot produce `-g 0`.
 */
export function gopLength(fps: number, segmentSeconds: number): number {
  const frames = Math.round(fps * segmentSeconds);
  return Number.isFinite(frames) && frames >= 1 ? frames : 1;
}

/** MPEG-TS packets start with this byte. Ciphertext, statistically, does not. */
export const TS_SYNC_BYTE = 0x47;

/**
 * Read the first segment of every rendition and refuse to continue if it looks
 * like a playable transport stream.
 *
 * A one-in-256 false pass per rendition is possible in principle, which is why
 * the check reads the first four packet boundaries rather than one byte: a real
 * TS file has 0x47 at offsets 0, 188, 376 and 564, and ciphertext matching all
 * four is a one-in-four-billion event.
 */
export async function assertEncrypted(
  absoluteOutput: string,
  renditions: RenditionResult[],
): Promise<void> {
  for (const rendition of renditions) {
    const first = join(absoluteOutput, rendition.name, 'seg00000.ts');
    const head = await readFile(first);
    if (looksLikeTransportStream(head)) {
      throw new Error(
        `Encryption did not take effect: ${rendition.name}/seg00000.ts is a plaintext MPEG-TS stream`,
      );
    }
  }
}

/** True when the buffer has the MPEG-TS sync byte at every packet boundary. */
export function looksLikeTransportStream(buffer: Buffer): boolean {
  const offsets = [0, 188, 376, 564];
  if (buffer.length <= offsets[offsets.length - 1]!) {
    return buffer.length > 0 && buffer[0] === TS_SYNC_BYTE;
  }
  return offsets.every((offset) => buffer[offset] === TS_SYNC_BYTE);
}

/**
 * Cross-check the playlist against the probed source.
 *
 * ffmpeg exits 0 on a source it could only partially read, so exit status alone
 * does not prove the whole lesson was encoded.
 */
export function assertDurationsMatch(
  sourceSeconds: number,
  renditions: RenditionResult[],
  segmentSeconds = 4,
): void {
  const allowed = sourceSeconds * DURATION_TOLERANCE_RATIO + segmentSeconds;
  for (const rendition of renditions) {
    const drift = Math.abs(rendition.playlistDurationSeconds - sourceSeconds);
    if (drift > allowed) {
      throw new Error(
        `${rendition.name} covers ${rendition.playlistDurationSeconds.toFixed(2)}s of a ` +
          `${sourceSeconds.toFixed(2)}s source (drift ${drift.toFixed(2)}s > ${allowed.toFixed(2)}s allowed)`,
      );
    }
  }
}

/**
 * The master playlist: one `#EXT-X-STREAM-INF` per rendition, which is the line
 * that makes the stream adaptive. A player reads the advertised BANDWIDTH and
 * RESOLUTION, measures its own throughput, and switches rungs without stopping.
 *
 * Sorted ascending so the first entry is the lowest rung: players that ignore
 * their own bandwidth estimate on the very first request start on the rendition
 * most likely to load, rather than stalling on 720p over cellular.
 */
export function buildMasterPlaylist(renditions: RenditionResult[], rungs: readonly Rung[]): string {
  const byName = new Map(rungs.map((rung) => [rung.name, rung]));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of [...renditions].sort((a, b) => a.height - b.height)) {
    const rung = byName.get(rendition.name);
    const width = rung?.width ?? Math.round((rendition.height * 16) / 9);
    // BANDWIDTH is in bits per second and is a peak, not an average: players
    // treat it as the rate they must sustain, so advertising the average makes
    // them pick a rung they cannot actually keep up with.
    const bandwidth = Math.round(rendition.bitrateKbps * 1000 * 1.1);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${rendition.height},CODECS="avc1.4d401f,mp4a.40.2"`,
    );
    lines.push(rendition.playlist);
  }
  return `${lines.join('\n')}\n`;
}
