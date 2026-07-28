/**
 * HLS playlist parsing and rewriting.
 *
 * Pure string work, no I/O, so every branch is unit-testable. This is the file
 * that turns the static playlists on disk into per-request ones: ffmpeg writes
 * relative segment names and a placeholder key URI, and the API rewrites both to
 * absolute URLs carrying a ticket before the bytes ever leave the process.
 *
 * Written by hand rather than with an m3u8 library on purpose. The grammar in
 * play is four tags, the rewrite has to preserve every line it does not
 * understand (a future tag must survive untouched), and a parser that discards
 * unknown lines would silently drop them. Twenty lines of code beats a
 * dependency that does more than is wanted.
 */

/**
 * What ffmpeg writes into `#EXT-X-KEY:URI="..."`. Never requested by anyone:
 * the API replaces it on every read. It is deliberately not a real URL so that
 * a playlist served without rewriting fails loudly instead of fetching
 * something.
 */
export const KEY_URI_PLACEHOLDER = 'lms-key://placeholder';

export interface ParsedMediaPlaylist {
  /** Segment file names in playback order, as written in the playlist. */
  segments: string[];
  /** Sum of the #EXTINF durations. */
  totalDuration: number;
  /** The URI in the #EXT-X-KEY line, or null when the playlist is unencrypted. */
  keyUri: string | null;
}

const EXTINF = '#EXTINF:';
const EXT_X_KEY = '#EXT-X-KEY:';

export function parseMediaPlaylist(text: string): ParsedMediaPlaylist {
  const segments: string[] = [];
  let totalDuration = 0;
  let keyUri: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith(EXTINF)) {
      // `#EXTINF:4.000000,` — the trailing comma is part of the grammar and the
      // optional title follows it.
      const value = line.slice(EXTINF.length).split(',')[0] ?? '';
      const seconds = Number(value);
      if (Number.isFinite(seconds)) totalDuration += seconds;
      continue;
    }
    if (line.startsWith(EXT_X_KEY)) {
      keyUri = attributeValue(line.slice(EXT_X_KEY.length), 'URI');
      continue;
    }
    // Any other tag line is metadata; anything that is not a tag is a segment.
    if (!line.startsWith('#')) segments.push(line);
  }

  return { segments, totalDuration, keyUri };
}

/**
 * Read one attribute out of an HLS attribute list.
 *
 * Quoted values may legitimately contain commas (a URI with a query string is
 * the case here), so this cannot be a `split(',')`.
 */
export function attributeValue(attributes: string, name: string): string | null {
  const quoted = new RegExp(`(?:^|,)${name}="([^"]*)"`).exec(attributes);
  if (quoted) return quoted[1] ?? null;
  const bare = new RegExp(`(?:^|,)${name}=([^,]*)`).exec(attributes);
  return bare ? (bare[1]?.trim() ?? null) : null;
}

export interface RewriteMediaPlaylistOptions {
  /** Absolute or root-relative URL each segment name is turned into. */
  segmentUrl: (segmentName: string) => string;
  /** URL the player should fetch the AES key from. */
  keyUrl: string;
}

/**
 * Rewrite a media playlist for one request.
 *
 * Every line the function does not recognise is passed through byte for byte.
 * That matters more than it sounds: `#EXT-X-MAP`, `#EXT-X-BYTERANGE` and future
 * tags all carry meaning this code has no opinion about, and a rewriter that
 * emitted only the lines it understood would produce a playlist that plays
 * subtly wrong rather than failing.
 */
export function rewriteMediaPlaylist(
  text: string,
  options: RewriteMediaPlaylistOptions,
): string {
  const out: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith(EXT_X_KEY)) {
      // Replace only the URI attribute. METHOD and IV must survive: dropping the
      // IV makes the player derive one from the segment sequence number, which
      // is not what the content was encrypted with, so playback yields noise.
      out.push(
        `${EXT_X_KEY}${replaceAttribute(line.slice(EXT_X_KEY.length), 'URI', options.keyUrl)}`,
      );
      continue;
    }
    if (line === '' || line.startsWith('#')) {
      out.push(rawLine.replace(/\r$/, ''));
      continue;
    }
    out.push(options.segmentUrl(line));
  }

  return out.join('\n');
}

/**
 * Rewrite a master playlist so each variant points at the API's rendition
 * route instead of at `360p/index.m3u8` on disk.
 */
export function rewriteMasterPlaylist(
  text: string,
  renditionUrl: (playlistPath: string) => string,
): string {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      out.push(rawLine.replace(/\r$/, ''));
      continue;
    }
    out.push(renditionUrl(line));
  }
  return out.join('\n');
}

function replaceAttribute(attributes: string, name: string, value: string): string {
  const quoted = new RegExp(`((?:^|,)${name}=)"[^"]*"`);
  if (quoted.test(attributes)) {
    return attributes.replace(quoted, `$1"${value}"`);
  }
  const bare = new RegExp(`((?:^|,)${name}=)[^,]*`);
  if (bare.test(attributes)) {
    return attributes.replace(bare, `$1"${value}"`);
  }
  return `${attributes},${name}="${value}"`;
}

/**
 * Names allowed in a media path segment.
 *
 * The playback routes take a rendition name and a segment name from the URL and
 * join them onto the media root, so this is the boundary that has to hold.
 * A whitelist, not a blacklist: `..` is the obvious attack but `%2e%2e`,
 * backslashes on a Windows host, a leading `/`, and a NUL byte truncating the
 * path in a syscall are all the same bug wearing different clothes, and none of
 * them match `[A-Za-z0-9._-]+`.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafePathSegment(name: string): boolean {
  // A name of "..", or one containing it, cannot match SAFE_NAME's first
  // character class, but the explicit check documents the intent for the next
  // reader and survives a loosening of the pattern.
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.length === 0 || name.length > 128) return false;
  return SAFE_NAME.test(name);
}
