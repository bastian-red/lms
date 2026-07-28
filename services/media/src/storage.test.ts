import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MediaPathError,
  isAllowedUploadName,
  isWritable,
  resolveWithin,
  safeExtension,
} from './storage';

const ROOT = '/srv/lms/media';

describe('resolveWithin', () => {
  it('joins safe components onto the root', () => {
    expect(resolveWithin(ROOT, 'assets', 'abc123', '720p', 'seg00000.ts')).toBe(
      resolve('/srv/lms/media/assets/abc123/720p/seg00000.ts'),
    );
  });

  it('refuses a traversal component', () => {
    // The attack the playback routes are exposed to: the rendition and segment
    // names come straight off the URL.
    expect(() => resolveWithin(ROOT, '..', 'etc', 'passwd')).toThrow(MediaPathError);
    expect(() => resolveWithin(ROOT, 'assets', '../../../etc/passwd')).toThrow(MediaPathError);
  });

  it('refuses an absolute component', () => {
    expect(() => resolveWithin(ROOT, '/etc/passwd')).toThrow(MediaPathError);
  });

  it('refuses a component with a separator in it', () => {
    expect(() => resolveWithin(ROOT, 'a/b')).toThrow(MediaPathError);
    expect(() => resolveWithin(ROOT, 'a\\b')).toThrow(MediaPathError);
  });

  it('refuses an empty component', () => {
    expect(() => resolveWithin(ROOT, '')).toThrow(MediaPathError);
  });

  it('refuses a NUL byte', () => {
    expect(() => resolveWithin(ROOT, 'seg\u0000.ts')).toThrow(MediaPathError);
  });

  it('never returns the root itself', () => {
    // A path equal to the root would be a directory, and streaming a directory
    // is an EISDIR at best.
    expect(() => resolveWithin(ROOT)).toThrow(MediaPathError);
  });

  it('always returns a descendant of the root', () => {
    for (const parts of [
      ['assets'],
      ['assets', 'a1'],
      ['assets', 'a1', '360p', 'index.m3u8'],
      ['sources', 'a1', 'source.mp4'],
    ]) {
      expect(resolveWithin(ROOT, ...parts).startsWith(`${resolve(ROOT)}/`)).toBe(true);
    }
  });
});

describe('safeExtension', () => {
  it('keeps a known container extension', () => {
    expect(safeExtension('lecture.mp4')).toBe('.mp4');
    expect(safeExtension('LECTURE.MOV')).toBe('.mov');
  });

  it('falls back for an unknown or hostile one', () => {
    expect(safeExtension('payload.php')).toBe('.mp4');
    expect(safeExtension('no-extension')).toBe('.mp4');
    expect(safeExtension('../../evil.sh')).toBe('.mp4');
  });
});

describe('isAllowedUploadName', () => {
  it('accepts video containers only', () => {
    expect(isAllowedUploadName('a.mp4')).toBe(true);
    expect(isAllowedUploadName('a.webm')).toBe(true);
    expect(isAllowedUploadName('a.pdf')).toBe(false);
    expect(isAllowedUploadName('a')).toBe(false);
  });
});

describe('isWritable', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lms-storage-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is true for a writable directory it can create', async () => {
    await expect(isWritable(join(dir, 'nested', 'media'))).resolves.toBe(true);
  });

  it('is false for a path it cannot create', async () => {
    // /proc/version is a file, so mkdir under it cannot succeed. This is the
    // shape of the real failure: a media volume mounted somewhere impossible.
    await expect(isWritable('/proc/version/media')).resolves.toBe(false);
  });
});
