import { describe, expect, it } from 'vitest';
import { parseRenditions } from './learning.service';

describe('parseRenditions', () => {
  it('reads what the worker writes, widest first', () => {
    const value = [
      { name: '360p', height: 360, bitrateKbps: 896, playlist: '360p/index.m3u8', segmentCount: 5 },
      { name: '720p', height: 720, bitrateKbps: 2928, playlist: '720p/index.m3u8', segmentCount: 5 },
    ];
    expect(parseRenditions(value).map((r) => r.name)).toEqual(['720p', '360p']);
  });

  it('survives a column written by an older pipeline', () => {
    // A malformed value costs the quality selector, never the lesson.
    expect(parseRenditions(null)).toEqual([]);
    expect(parseRenditions('nonsense')).toEqual([]);
    expect(parseRenditions([{ name: '360p' }])).toEqual([]);
    expect(parseRenditions([1, 2, 3])).toEqual([]);
  });

  it('drops only the malformed entries, keeping the good ones', () => {
    const value = [{ name: '720p', height: 720, bitrateKbps: 2928 }, { broken: true }];
    expect(parseRenditions(value)).toHaveLength(1);
  });
});
