import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LADDER, ladderFor, mediaConfigFromEnv, resolveMediaRoot } from './config';

describe('ladderFor', () => {
  it('produces the full ladder for a 720p source', () => {
    expect(ladderFor(720).map((rung) => rung.name)).toEqual(['360p', '540p', '720p']);
  });

  it('never upscales', () => {
    // Encoding 360p up to 720p spends CPU and bandwidth to deliver a blurrier
    // picture than the source, which is strictly worse for everyone.
    expect(ladderFor(360).map((rung) => rung.name)).toEqual(['360p']);
    expect(ladderFor(540).map((rung) => rung.name)).toEqual(['360p', '540p']);
  });

  it('still returns a rung for a source below the lowest one', () => {
    // A ladder with no rungs is not a stream.
    expect(ladderFor(144)).toEqual([LADDER[0]]);
  });

  it('uses even widths, which libx264 requires', () => {
    for (const rung of LADDER) {
      expect(rung.width % 2).toBe(0);
      expect(rung.height % 2).toBe(0);
    }
  });

  it('has strictly increasing bitrates, so a player can rank them', () => {
    for (let i = 1; i < LADDER.length; i += 1) {
      expect(LADDER[i]!.videoKbps).toBeGreaterThan(LADDER[i - 1]!.videoKbps);
    }
  });
});

describe('resolveMediaRoot', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lms-root-'));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(root, 'packages', 'db'), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('anchors a relative path to the repo root, whatever the cwd', () => {
    // The bug this prevents: the seed runs from packages/db, the API from the
    // repo root, and each writes media somewhere the other cannot find.
    const fromRoot = resolveMediaRoot('./var/media', root);
    const fromPackage = resolveMediaRoot('./var/media', join(root, 'packages', 'db'));
    expect(fromPackage).toBe(fromRoot);
    expect(fromRoot).toBe(resolve(root, 'var/media'));
  });

  it('uses an absolute path as given', () => {
    expect(resolveMediaRoot('/data/media', join(root, 'packages', 'db'))).toBe('/data/media');
  });

  it('falls back to the cwd when there is no workspace marker', () => {
    expect(resolveMediaRoot('./var/media', tmpdir())).toBe(resolve(tmpdir(), 'var/media'));
  });
});

describe('mediaConfigFromEnv', () => {
  it('defaults the binaries to PATH lookups', () => {
    const config = mediaConfigFromEnv({});
    expect(config.ffmpegPath).toBe('ffmpeg');
    expect(config.ffprobePath).toBe('ffprobe');
  });

  it('honours the overrides', () => {
    const config = mediaConfigFromEnv({ FFMPEG_PATH: '/opt/ffmpeg', FFPROBE_PATH: '/opt/ffprobe' });
    expect(config.ffmpegPath).toBe('/opt/ffmpeg');
  });

  it('treats a blank numeric variable as absent rather than as zero', () => {
    // `Number('')` is 0, which would mean zero-second segments and an instant
    // transcode timeout.
    const config = mediaConfigFromEnv({ HLS_SEGMENT_SECONDS: '  ', TRANSCODE_TIMEOUT_MS: '' });
    expect(config.segmentSeconds).toBe(4);
    expect(config.transcodeTimeoutMs).toBe(15 * 60_000);
  });

  it('rejects a non-positive segment length', () => {
    expect(mediaConfigFromEnv({ HLS_SEGMENT_SECONDS: '0' }).segmentSeconds).toBe(4);
    expect(mediaConfigFromEnv({ HLS_SEGMENT_SECONDS: '-5' }).segmentSeconds).toBe(4);
  });
});
