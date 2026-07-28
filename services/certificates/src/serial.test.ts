import { describe, expect, it } from 'vitest';
import { generateSerial, isValidSerial, normalizeSerial } from './serial';

describe('generateSerial', () => {
  it('produces the printed format', () => {
    expect(generateSerial()).toMatch(/^LMS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('never emits a character that reads as another', () => {
    // I/1, O/0, S/5 and Z/2 are the pairs people mistype off a printed page.
    // Checked on the body only: the fixed "LMS-" prefix is not random and its
    // S is read in context, not character by character.
    for (let n = 0; n < 500; n += 1) {
      const body = generateSerial().slice('LMS-'.length).replace(/-/g, '');
      expect(body).not.toMatch(/[IOSZ01]/);
    }
  });

  it('does not repeat within a large sample', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 5_000; n += 1) seen.add(generateSerial());
    expect(seen.size).toBe(5_000);
  });

  it('uses the whole alphabet rather than a biased slice', () => {
    // Rejection sampling exists so a modulo bias does not shrink the real
    // search space; a biased generator shows up as missing symbols.
    const characters = new Set<string>();
    for (let n = 0; n < 2_000; n += 1) {
      for (const character of generateSerial().replace(/[-]|^LMS/g, '')) characters.add(character);
    }
    expect(characters.size).toBe(29);
  });
});

describe('normalizeSerial', () => {
  it('accepts the exact printed form', () => {
    expect(normalizeSerial('LMS-ABCD-EFGH-JKMN')).toBe('LMS-ABCD-EFGH-JKMN');
  });

  it('accepts it typed without dashes, in lower case', () => {
    expect(normalizeSerial('lmsabcdefghjkmn')).toBe('LMS-ABCD-EFGH-JKMN');
  });

  it('accepts it with stray whitespace', () => {
    expect(normalizeSerial('  LMS ABCD EFGH JKMN  ')).toBe('LMS-ABCD-EFGH-JKMN');
  });

  it('rejects a wrong length rather than padding it', () => {
    expect(normalizeSerial('LMS-ABCD')).toBe('');
    expect(normalizeSerial('LMS-ABCD-EFGH-JKMN-PQRT')).toBe('');
  });
});

describe('isValidSerial', () => {
  it('accepts what the generator produces', () => {
    for (let n = 0; n < 200; n += 1) {
      expect(isValidSerial(generateSerial())).toBe(true);
    }
  });

  it('rejects a serial containing an excluded character', () => {
    expect(isValidSerial('LMS-ABCD-EFGH-JKM0')).toBe(false);
  });

  it('rejects nonsense without throwing', () => {
    for (const input of ['', 'nope', '../../etc/passwd', "'; DROP TABLE certificates; --"]) {
      expect(isValidSerial(input)).toBe(false);
    }
  });
});
