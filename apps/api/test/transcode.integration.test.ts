import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  looksLikeTransportStream,
  mediaConfigFromEnv,
  parseMediaPlaylist,
  runOrThrow,
  transcode,
} from '@lms/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './helpers';

/**
 * The transcode pipeline, against a real ffmpeg.
 *
 * Every test here generates its own source with `testsrc2`, so the suite needs
 * no fixture files and the repo contains no binaries. That is the same trick the
 * seed uses, for the same reason.
 */
describe('transcode pipeline', () => {
  const config = { ...mediaConfigFromEnv(), root: '' };
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lms-transcode-test-'));
    config.root = root;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  /** Generate a synthetic clip. */
  async function makeSource(name: string, seconds: number, height: number): Promise<string> {
    const path = join(root, `${name}.mp4`);
    const width = Math.round((height * 16) / 9 / 2) * 2;
    await runOrThrow(
      config.ffmpegPath,
      [
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        path,
      ],
      { timeoutMs: 120_000 },
    );
    return path;
  }

  it('produces an encrypted three-rung ladder from a 720p source', async () => {
    const source = await makeSource('source-720', 8, 720);
    const result = await transcode({ config, sourcePath: source, outputDir: 'out-720' });

    expect(result.renditions.map((r) => r.name)).toEqual(['360p', '540p', '720p']);
    expect(result.key).toHaveLength(16);
    expect(result.iv).toHaveLength(16);
    expect(result.probe.durationSeconds).toBeCloseTo(8, 0);

    for (const rendition of result.renditions) {
      const segment = await readFile(join(root, 'out-720', rendition.name, 'seg00000.ts'));
      expect(looksLikeTransportStream(segment)).toBe(false);
    }
  });

  it('never upscales a source below the top rung', async () => {
    // Encoding 360p up to 720p spends CPU and bandwidth to deliver a blurrier
    // picture than the source.
    const source = await makeSource('source-360', 5, 360);
    const result = await transcode({ config, sourcePath: source, outputDir: 'out-360' });
    expect(result.renditions.map((r) => r.name)).toEqual(['360p']);
  });

  it('writes a master playlist that makes the stream adaptive', async () => {
    const master = await readFile(join(root, 'out-720', 'master.m3u8'), 'utf8');
    expect(master.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(3);
    expect(master).toContain('RESOLUTION=640x360');
    expect(master).toContain('RESOLUTION=1280x720');

    // Ascending, so a player that ignores its own first bandwidth estimate
    // starts on the rung most likely to load.
    const bandwidths = [...master.matchAll(/BANDWIDTH=(\d+)/g)].map((m) => Number(m[1]));
    expect(bandwidths).toEqual([...bandwidths].sort((a, b) => a - b));
  });

  it('aligns segment boundaries across renditions, which is what lets a player switch', async () => {
    const durations = await Promise.all(
      ['360p', '540p', '720p'].map(async (rung) => {
        const playlist = await readFile(join(root, 'out-720', rung, 'index.m3u8'), 'utf8');
        return parseMediaPlaylist(playlist);
      }),
    );

    // Same number of segments, and the same cumulative timeline. Misaligned
    // boundaries make a mid-stream rendition switch stall or skip.
    const counts = durations.map((playlist) => playlist.segments.length);
    expect(new Set(counts).size).toBe(1);
    for (const playlist of durations) {
      expect(playlist.totalDuration).toBeCloseTo(durations[0]!.totalDuration, 1);
    }
  });

  it('leaves no key material in the output directory', async () => {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(root, 'out-720'), { recursive: true });
    for (const entry of entries as string[]) {
      expect(entry.toLowerCase()).not.toContain('key');
    }
  });

  it('reuses a supplied key, so a re-transcode does not break cached segments', async () => {
    const source = await makeSource('source-reuse', 5, 360);
    const first = await transcode({ config, sourcePath: source, outputDir: 'out-reuse' });
    const second = await transcode({
      config,
      sourcePath: source,
      outputDir: 'out-reuse',
      key: first.key,
      iv: first.iv,
    });
    expect(second.key.equals(first.key)).toBe(true);
    expect(second.iv.equals(first.iv)).toBe(true);
  });

  it('refuses a file that is not decodable rather than storing a broken asset', async () => {
    const { writeFile } = await import('node:fs/promises');
    const bogus = join(root, 'not-a-video.mp4');
    await writeFile(bogus, Buffer.from('this is not a video file'));
    await expect(
      transcode({ config, sourcePath: bogus, outputDir: 'out-bogus' }),
    ).rejects.toThrow();
  });

  it('handles a source with no audio track', async () => {
    // `-an` rather than letting the muxer guess: a variant that advertises
    // audio it does not have makes some players wait forever.
    const silent = join(root, 'silent.mp4');
    await runOrThrow(
      config.ffmpegPath,
      [
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30:duration=4',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        silent,
      ],
      { timeoutMs: 60_000 },
    );

    const result = await transcode({ config, sourcePath: silent, outputDir: 'out-silent' });
    expect(result.probe.hasAudio).toBe(false);
    expect(result.renditions).toHaveLength(1);
  });

  it('clears a previous ladder rather than merging with it', async () => {
    // Stale segments from an earlier attempt would be served alongside the new
    // key and decrypt to noise.
    const tall = await makeSource('source-tall', 4, 720);
    await transcode({ config, sourcePath: tall, outputDir: 'out-replace' });

    const short = await makeSource('source-short', 4, 360);
    await transcode({ config, sourcePath: short, outputDir: 'out-replace' });

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(root, 'out-replace'));
    expect(entries).toContain('360p');
    expect(entries).not.toContain('720p');
  });
});
