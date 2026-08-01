import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTokens, parseHex, resolve } from './contrast';

/**
 * The identity lock.
 *
 * This repo is one of a portfolio, and the portfolio's failure mode is that
 * every project ends up wearing whatever visual language the last one wore.
 * That is not hypothetical: this app, the booking app and the shop all shipped
 * the same three typefaces and the same `#ff0000` signal accent, so a reader
 * opening all three saw one designer with one trick.
 *
 * "The LMS looks like the LMS" is not a judgement call — it is a set of values
 * in four files. So it lives here, where drifting back toward a shared palette
 * fails a commit instead of passing review.
 *
 * When the identity genuinely changes, change these constants deliberately and
 * say why in the commit. That is the point: it should cost a decision.
 */
const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');
const learn = readFileSync(join(APP, 'learn.css'), 'utf8');
const consoleCss = readFileSync(join(APP, 'console.css'), 'utf8');
const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');

/** "Focused study" over "cool console". See the header comments in the CSS. */
const IDENTITY = {
  consoleDark: { '--bg': '#0b1220', '--accent': '#60a5fa' },
  consoleLight: { '--bg': '#f8fafc', '--accent': '#1d4ed8' },
  learnDark: { '--bg': '#14120f', '--accent': '#5eead4' },
  learnLight: { '--bg': '#fbf8f3', '--accent': '#0f766e' },
  radius: { console: '2px', learn: '8px' },
  fonts: ['IBM_Plex_Sans', 'JetBrains_Mono', 'Source_Serif_4'],
} as const;

const consoleDark = extractTokens(globals, ':root');
const consoleLight = {
  ...consoleDark,
  ...extractTokens(globals, '@media (prefers-color-scheme: light)'),
};
const learnDark = { ...consoleDark, ...extractTokens(learn, "[data-surface='learn']") };
const learnLight = {
  ...consoleLight,
  ...extractTokens(learn, "[data-surface='learn']"),
  ...extractTokens(learn, '@media (prefers-color-scheme: light)'),
};

/** Every face this app pulls out of `next/font/google`. */
function importedFaces(): string[] {
  const line = /import\s*\{([^}]*)\}\s*from\s*'next\/font\/google'/.exec(layout);
  if (!line) throw new Error('layout.tsx imports nothing from next/font/google');
  return line[1]!
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

describe('visual identity', () => {
  it.each(Object.entries(IDENTITY.consoleDark))('console dark %s is %s', (token, expected) => {
    expect(resolve(consoleDark, token).toLowerCase()).toBe(expected);
  });

  it.each(Object.entries(IDENTITY.consoleLight))('console light %s is %s', (token, expected) => {
    expect(resolve(consoleLight, token).toLowerCase()).toBe(expected);
  });

  it.each(Object.entries(IDENTITY.learnDark))('learn dark %s is %s', (token, expected) => {
    expect(resolve(learnDark, token).toLowerCase()).toBe(expected);
  });

  it.each(Object.entries(IDENTITY.learnLight))('learn light %s is %s', (token, expected) => {
    expect(resolve(learnLight, token).toLowerCase()).toBe(expected);
  });

  it('loads exactly the faces this identity is built on', () => {
    // Exact, not "at least": an extra face is how a shared house style creeps
    // back in one import at a time.
    expect(importedFaces()).toEqual([...IDENTITY.fonts].sort());
  });

  it('keeps the console tighter-cornered than Learn', () => {
    // A dense grid reads cleaner with square cells; a page someone reads for
    // twenty minutes does not need to look like a spreadsheet.
    expect(consoleDark['--radius']).toBe(IDENTITY.radius.console);
    expect(learnDark['--radius']).toBe(IDENTITY.radius.learn);
  });

  it('does not reintroduce the shared signal red', () => {
    // #ff0000 was the one accent all three portfolio projects shared.
    for (const [name, css] of [
      ['globals.css', globals],
      ['learn.css', learn],
      ['console.css', consoleCss],
    ] as const) {
      expect([...css.matchAll(/#ff0000|#f00\b/gi)], name).toHaveLength(0);
    }
  });

  it('carries no dot-matrix face and no dot-grid texture', () => {
    // Both were tics of the design language this repo moved away from.
    for (const css of [globals, learn, consoleCss]) {
      expect(css).not.toMatch(/--ff-dot|--dot-grid|--font-dot/);
    }
    expect(importedFaces().join(' ')).not.toMatch(/Doto|Space_/);
  });
});

/**
 * The two surfaces have to be visibly different surfaces.
 *
 * The whole reason Learn has its own palette is that a student and an
 * instructor are doing opposite things. "Warm paper vs cool slate" is a claim
 * about hex values, so it is measured rather than asserted.
 */
describe('Learn and the console do not look alike', () => {
  /** Signed warmth: red channel minus blue channel, normalised. Positive is warm. */
  const warmth = (hex: string): number => {
    const { r, b } = parseHex(hex);
    return (r - b) / 255;
  };

  it.each([
    ['dark', learnDark, consoleDark],
    ['light', learnLight, consoleLight],
  ])('%s: Learn is warm and the console is not', (_scheme, learnPalette, consolePalette) => {
    expect(warmth(resolve(learnPalette, '--bg'))).toBeGreaterThan(0);
    expect(warmth(resolve(consolePalette, '--bg'))).toBeLessThan(0);
  });

  it.each([
    ['dark', learnDark, consoleDark],
    ['light', learnLight, consoleLight],
  ])('%s: the accents mean different things, so they are different colours', (
    _scheme,
    learnPalette,
    consolePalette,
  ) => {
    // Teal means progress in Learn; blue means control in the console. A
    // student never sees one and an instructor never sees the other.
    expect(resolve(learnPalette, '--accent')).not.toBe(resolve(consolePalette, '--accent'));
  });
});
