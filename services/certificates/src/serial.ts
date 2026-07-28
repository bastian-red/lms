import { randomBytes } from 'node:crypto';

/**
 * Certificate serials.
 *
 * A serial is printed on the PDF and typed into /verify/[serial] by whoever is
 * checking it, so it has three jobs: unguessable, unambiguous when read aloud,
 * and short enough that a person will actually type it.
 */

/**
 * Crockford base32 minus the letters that read as digits.
 *
 * I/1, O/0, S/5 and Z/2 are the pairs people confuse on a printed page, and a
 * verification page that rejects a correctly-copied serial because of a font is
 * worse than a slightly shorter alphabet. 29 symbols over 12 characters is a
 * little over 58 bits, which is not brute-forceable through a rate-limited
 * HTTP endpoint.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRTUVWXY';
const LENGTH = 12;
const GROUP = 4;

export function generateSerial(): string {
  // Rejection sampling rather than `% ALPHABET.length`. The modulo of a uniform
  // byte over a 29-symbol alphabet is biased toward the first few symbols, which
  // measurably shrinks the search space.
  const out: string[] = [];
  while (out.length < LENGTH) {
    for (const byte of randomBytes(LENGTH)) {
      if (out.length >= LENGTH) break;
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
    }
  }
  // Grouped for legibility: LMS-XXXX-XXXX-XXXX.
  const grouped: string[] = [];
  for (let i = 0; i < out.length; i += GROUP) {
    grouped.push(out.slice(i, i + GROUP).join(''));
  }
  return `LMS-${grouped.join('-')}`;
}

/**
 * Accept a serial however it was typed.
 *
 * People paste it with the dashes, type it without them, and use lower case.
 * All three describe the same certificate, so normalisation happens before the
 * lookup rather than being enforced on the person holding the paper.
 */
export function normalizeSerial(input: string): string {
  const bare = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^LMS/, '');
  if (bare.length !== LENGTH) return '';
  const grouped: string[] = [];
  for (let i = 0; i < bare.length; i += GROUP) {
    grouped.push(bare.slice(i, i + GROUP));
  }
  return `LMS-${grouped.join('-')}`;
}

export function isValidSerial(input: string): boolean {
  const normalized = normalizeSerial(input);
  if (normalized === '') return false;
  return normalized
    .slice('LMS-'.length)
    .replace(/-/g, '')
    .split('')
    .every((character) => ALPHABET.includes(character));
}
