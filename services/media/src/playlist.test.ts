import { describe, expect, it } from 'vitest';
import {
  attributeValue,
  isSafePathSegment,
  KEY_URI_PLACEHOLDER,
  parseMediaPlaylist,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
} from './playlist';

/** A media playlist shaped exactly like the one ffmpeg writes. */
const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  `#EXT-X-KEY:METHOD=AES-128,URI="${KEY_URI_PLACEHOLDER}",IV=0x00112233445566778899aabbccddeeff`,
  '#EXTINF:4.000000,',
  'seg00000.ts',
  '#EXTINF:4.000000,',
  'seg00001.ts',
  '#EXTINF:2.560000,',
  'seg00002.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=985600,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2"',
  '360p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3220800,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720p/index.m3u8',
  '',
].join('\n');

describe('parseMediaPlaylist', () => {
  it('reads the segments in playback order', () => {
    expect(parseMediaPlaylist(MEDIA_PLAYLIST).segments).toEqual([
      'seg00000.ts',
      'seg00001.ts',
      'seg00002.ts',
    ]);
  });

  it('sums the EXTINF durations', () => {
    // The number the transcode is cross-checked against.
    expect(parseMediaPlaylist(MEDIA_PLAYLIST).totalDuration).toBeCloseTo(10.56, 5);
  });

  it('finds the key URI', () => {
    expect(parseMediaPlaylist(MEDIA_PLAYLIST).keyUri).toBe(KEY_URI_PLACEHOLDER);
  });

  it('reports a null key URI for an unencrypted playlist', () => {
    // This is what makes "the transcode silently produced plaintext" a caught
    // failure rather than a shipped one.
    const plain = MEDIA_PLAYLIST.split('\n')
      .filter((line) => !line.startsWith('#EXT-X-KEY'))
      .join('\n');
    expect(parseMediaPlaylist(plain).keyUri).toBeNull();
  });

  it('ignores a malformed EXTINF instead of producing NaN', () => {
    const broken = '#EXTM3U\n#EXTINF:not-a-number,\nseg00000.ts\n';
    expect(parseMediaPlaylist(broken).totalDuration).toBe(0);
  });

  it('tolerates CRLF line endings', () => {
    const crlf = MEDIA_PLAYLIST.replace(/\n/g, '\r\n');
    expect(parseMediaPlaylist(crlf).segments).toHaveLength(3);
  });
});

describe('attributeValue', () => {
  it('reads a quoted value containing commas', () => {
    // The rewritten URI carries a query string, so a split(',') parser breaks
    // exactly here.
    const attributes = 'METHOD=AES-128,URI="https://x/key?a=1,b=2",IV=0x00';
    expect(attributeValue(attributes, 'URI')).toBe('https://x/key?a=1,b=2');
  });

  it('reads an unquoted value', () => {
    expect(attributeValue('METHOD=AES-128,IV=0x00', 'IV')).toBe('0x00');
  });

  it('does not match a name that is a suffix of another', () => {
    expect(attributeValue('AUDIO-URI="a",URI="b"', 'URI')).toBe('b');
  });

  it('returns null when the attribute is absent', () => {
    expect(attributeValue('METHOD=NONE', 'URI')).toBeNull();
  });
});

describe('rewriteMediaPlaylist', () => {
  const rewritten = rewriteMediaPlaylist(MEDIA_PLAYLIST, {
    segmentUrl: (name) => `https://api.test/lessons/L1/segment/${name}?t=TICKET`,
    keyUrl: 'https://api.test/lessons/L1/key?t=TICKET',
  });

  it('points every segment at the authenticated route', () => {
    // Nothing under the media root is statically served, so an un-rewritten
    // relative name would 404 rather than leak — but it would also mean no
    // lesson plays.
    expect(parseMediaPlaylist(rewritten).segments).toEqual([
      'https://api.test/lessons/L1/segment/seg00000.ts?t=TICKET',
      'https://api.test/lessons/L1/segment/seg00001.ts?t=TICKET',
      'https://api.test/lessons/L1/segment/seg00002.ts?t=TICKET',
    ]);
  });

  it('replaces the placeholder key URI', () => {
    expect(rewritten).not.toContain(KEY_URI_PLACEHOLDER);
    expect(parseMediaPlaylist(rewritten).keyUri).toBe('https://api.test/lessons/L1/key?t=TICKET');
  });

  it('keeps METHOD and IV intact', () => {
    // Dropping the IV makes the player derive one from the media sequence
    // number, which is not what the content was encrypted with, so every
    // segment decrypts to noise and the failure looks like a codec bug.
    expect(rewritten).toContain('METHOD=AES-128');
    expect(rewritten).toContain('IV=0x00112233445566778899aabbccddeeff');
  });

  it('passes through every tag it does not understand', () => {
    const withUnknown = `${MEDIA_PLAYLIST}#EXT-X-FUTURE-TAG:whatever\n`;
    const out = rewriteMediaPlaylist(withUnknown, {
      segmentUrl: (name) => name,
      keyUrl: 'k',
    });
    expect(out).toContain('#EXT-X-FUTURE-TAG:whatever');
    expect(out).toContain('#EXT-X-TARGETDURATION:4');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('adds a URI attribute when the key line somehow lacks one', () => {
    const out = rewriteMediaPlaylist('#EXT-X-KEY:METHOD=AES-128\nseg.ts\n', {
      segmentUrl: (name) => name,
      keyUrl: 'https://api.test/key',
    });
    expect(parseMediaPlaylist(out).keyUri).toBe('https://api.test/key');
  });

  it('is idempotent in shape: rewriting twice yields the same segment count', () => {
    const twice = rewriteMediaPlaylist(rewritten, {
      segmentUrl: (name) => name,
      keyUrl: 'https://api.test/key2',
    });
    expect(parseMediaPlaylist(twice).segments).toHaveLength(3);
  });
});

describe('rewriteMasterPlaylist', () => {
  it('points each variant at the rendition route', () => {
    const out = rewriteMasterPlaylist(
      MASTER_PLAYLIST,
      (path) => `https://api.test/lessons/L1/rendition/${path}?t=TICKET`,
    );
    expect(out).toContain('https://api.test/lessons/L1/rendition/360p/index.m3u8?t=TICKET');
    expect(out).toContain('https://api.test/lessons/L1/rendition/720p/index.m3u8?t=TICKET');
  });

  it('keeps the STREAM-INF lines, which are what make the stream adaptive', () => {
    const out = rewriteMasterPlaylist(MASTER_PLAYLIST, (path) => path);
    expect(out.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(2);
    expect(out).toContain('RESOLUTION=640x360');
    expect(out).toContain('RESOLUTION=1280x720');
  });
});

describe('isSafePathSegment', () => {
  it('accepts the names the pipeline produces', () => {
    for (const name of ['seg00000.ts', 'index.m3u8', '360p', 'master.m3u8']) {
      expect(isSafePathSegment(name)).toBe(true);
    }
  });

  it('refuses every shape of traversal', () => {
    for (const name of [
      '..',
      '../etc/passwd',
      '..%2fetc',
      'a/../../b',
      '/etc/passwd',
      'a\\..\\b',
      '.hidden',
      '',
      'a'.repeat(200),
    ]) {
      expect(isSafePathSegment(name)).toBe(false);
    }
  });

  it('refuses a NUL byte, which truncates the path in the syscall', () => {
    expect(isSafePathSegment('seg00000.ts\u0000.txt')).toBe(false);
  });

  it('refuses a percent-encoded separator', () => {
    // Express decodes route params, but a double-encoded value can arrive
    // still-encoded; the whitelist rejects it either way.
    expect(isSafePathSegment('%2e%2e')).toBe(false);
    expect(isSafePathSegment('a%2Fb')).toBe(false);
  });
});
