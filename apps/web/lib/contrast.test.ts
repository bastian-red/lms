import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AA_NORMAL,
  AA_UI,
  contrastRatio,
  extractTokens,
  parseHex,
  ratio,
  relativeLuminance,
  resolve,
} from './contrast';

/**
 * The colour gate.
 *
 * Every foreground/background pair the product actually renders is checked
 * against WCAG AA, in both colour schemes, on both surfaces. It reads the real
 * stylesheets, so it cannot pass against a stale copy of the palette.
 *
 * This exists because the baseline axe run found 22 contrast failures that came
 * from a single token — `--muted: #737373` on `--surface-2: #f5f5f5`, 4.07:1 —
 * and nobody saw it by looking. Contrast is arithmetic. Arithmetic belongs in a
 * test, not in anyone's eye.
 */
const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');
const learn = readFileSync(join(APP, 'learn.css'), 'utf8');

/** Console is the default palette, declared on `:root`. */
const consoleDark = extractTokens(globals, ':root');
const consoleLight = { ...consoleDark, ...extractTokens(globals, '@media (prefers-color-scheme: light)') };

/** Learn overrides a subset, so it layers on top of the Console palette. */
const learnDark = { ...consoleDark, ...extractTokens(learn, "[data-surface='learn']") };
const learnLight = {
  ...consoleLight,
  ...extractTokens(learn, "[data-surface='learn']"),
  ...extractTokens(learn, '@media (prefers-color-scheme: light)'),
};

const PALETTES = {
  'console / dark': consoleDark,
  'console / light': consoleLight,
  'learn / dark': learnDark,
  'learn / light': learnLight,
} as const;

/** Backgrounds any of these foregrounds can legitimately land on. */
const BACKGROUNDS = ['--bg', '--surface', '--surface-2'] as const;

/** Text-weight foregrounds: must clear 4.5:1 on every background. */
const TEXT = ['--text', '--muted', '--accent-ink', '--state-pass', '--state-fail', '--state-warn', '--state-info', '--state-idle'] as const;

describe('pure contrast maths', () => {
  it('computes the canonical extremes', () => {
    expect(ratio('#000000', '#ffffff')).toBe(21);
    expect(ratio('#ffffff', '#ffffff')).toBe(1);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(
      contrastRatio('#abcdef', '#123456'),
      10,
    );
  });

  it('expands three-digit hex', () => {
    expect(parseHex('#fff')).toEqual(parseHex('#ffffff'));
    expect(parseHex('0af')).toEqual({ r: 0, g: 170, b: 255 });
  });

  it('rejects nonsense rather than scoring it', () => {
    expect(() => parseHex('rebeccapurple')).toThrow(/not a hex colour/);
    expect(() => parseHex('#12345')).toThrow(/not a hex colour/);
  });

  it('matches the WCAG luminance of the reference greys', () => {
    expect(relativeLuminance(parseHex('#000000'))).toBe(0);
    expect(relativeLuminance(parseHex('#ffffff'))).toBeCloseTo(1, 10);
    expect(relativeLuminance(parseHex('#808080'))).toBeCloseTo(0.2159, 3);
  });
});

describe('token extraction', () => {
  it('reads custom properties out of a block', () => {
    const tokens = extractTokens(':root { --a: #fff; --b: 4px; }', ':root');
    expect(tokens).toEqual({ '--a': '#fff', '--b': '4px' });
  });

  it('walks nested braces so a media query does not truncate the block', () => {
    const css = '@media (prefers-color-scheme: light) { :root { --a: #000; } }';
    expect(extractTokens(css, '@media (prefers-color-scheme: light)')).toEqual({ '--a': '#000' });
  });

  it('follows var() indirection', () => {
    expect(resolve({ '--a': 'var(--b)', '--b': '#123456' }, '--a')).toBe('#123456');
  });

  it('throws on a circular reference instead of hanging', () => {
    expect(() => resolve({ '--a': 'var(--b)', '--b': 'var(--a)' }, '--a')).toThrow(/circular/);
  });

  it('throws on a missing token rather than skipping the check', () => {
    expect(() => resolve({}, '--nope')).toThrow(/undefined token/);
  });

  it('found a real palette in every scope', () => {
    for (const [name, palette] of Object.entries(PALETTES)) {
      expect(resolve(palette, '--text'), name).toMatch(/^#/);
      expect(resolve(palette, '--bg'), name).toMatch(/^#/);
    }
  });
});

describe.each(Object.entries(PALETTES))('%s palette', (scope, palette) => {
  describe.each(TEXT)('%s', (fg) => {
    it.each(BACKGROUNDS)(`clears AA on %s`, (bg) => {
      const foreground = resolve(palette, fg);
      const background = resolve(palette, bg);
      const measured = ratio(foreground, background);
      expect(
        measured,
        `${scope}: ${fg} (${foreground}) on ${bg} (${background}) is ${measured}:1, needs ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  it('--border-strong clears 3:1 against --bg, because it bounds form controls', () => {
    const border = resolve(palette, '--border-strong');
    const background = resolve(palette, '--bg');
    const measured = ratio(border, background);
    expect(
      measured,
      `${scope}: --border-strong (${border}) on --bg (${background}) is ${measured}:1, needs ${AA_UI}:1`,
    ).toBeGreaterThanOrEqual(AA_UI);
  });

  it('the primary button inverts without losing contrast', () => {
    // .btn-primary paints --text as its fill and --bg as its label.
    const measured = ratio(resolve(palette, '--bg'), resolve(palette, '--text'));
    expect(measured, `${scope}: primary button`).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('--surface is distinguishable from --bg', () => {
    // Not a WCAG rule, a real regression: light mode had --surface === --bg, so
    // every .card and .certificate silently lost its surface.
    expect(
      resolve(palette, '--surface'),
      `${scope}: --surface must not equal --bg`,
    ).not.toBe(resolve(palette, '--bg'));
  });

  it('pass and fail separate in greyscale, not only in hue', () => {
    // Two state colours can each clear AA against the background and still be
    // the same tone as each other. Red and green at equal luminance is exactly
    // that case, and it is the most common colour-vision deficiency there is:
    // both answers render as one grey.
    //
    // The threshold is 1.5 rather than a text-grade ratio on purpose. Colour is
    // the *secondary* channel here — the primary ones are the glyph and the
    // word, asserted in e2e/tests/quiz-layout.spec.ts. This only guarantees the
    // colour is not quietly contradicting them.
    const measured = ratio(resolve(palette, '--state-pass'), resolve(palette, '--state-fail'));
    expect(measured, `${scope}: pass vs fail`).toBeGreaterThanOrEqual(1.5);
  });
});
