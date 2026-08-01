import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTokens } from './contrast';

/**
 * Every `var(--x)` in the codebase resolves to a token that exists.
 *
 * This exists because of a bug that shipped silently during the redesign.
 * `--panel-2` was renamed to `--surface-2`, and `components/retention-charts.tsx`
 * kept passing `fill="var(--panel-2)"` into Recharts. An undefined custom
 * property in an SVG `fill` does not warn, does not throw, and does not fail a
 * type check — it falls back to the SVG default, which is black. The instructor's
 * retention charts rendered as solid dark slabs and every one of the 116 tests
 * still passed.
 *
 * The class of failure is "a rename that the compiler cannot see", and the only
 * thing that catches it is checking the two sides against each other.
 */
const WEB = join(__dirname, '..');
const APP = join(WEB, 'app');

/** Every token declared anywhere in the three stylesheets. */
function declaredTokens(): Set<string> {
  const declared = new Set<string>();
  for (const file of ['globals.css', 'learn.css', 'console.css']) {
    const css = readFileSync(join(APP, file), 'utf8');
    // Any `--name:` at a declaration position, in any block.
    for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(match[1]);
  }
  return declared;
}

/** Every `var(--x)` reference, with the file it came from. */
function referencedTokens(): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const skip = new Set(['node_modules', '.next', '.turbo', 'dist']);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      // Only files that reach the DOM. Test files and the token tooling itself
      // contain `var(--a)` as fixtures and in doc comments, which are not
      // references a browser will ever try to resolve.
      if (!/\.(tsx?|css)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const where = references.get(match[1]) ?? [];
        where.push(path.slice(WEB.length + 1));
        references.set(match[1], where);
      }
    }
  };

  walk(join(WEB, 'app'));
  walk(join(WEB, 'components'));
  return references;
}

describe('design tokens', () => {
  const declared = declaredTokens();
  const referenced = referencedTokens();

  it('found tokens on both sides, so the scan is actually running', () => {
    expect(declared.size).toBeGreaterThan(30);
    expect(referenced.size).toBeGreaterThan(20);
  });

  it('every referenced token is declared', () => {
    // next/font injects --font-display / --font-ui / --font-mono at runtime;
    // they are declared in layout.tsx, not in CSS.
    const external = new Set(['--font-display', '--font-ui', '--font-mono']);

    const dangling = [...referenced.entries()]
      .filter(([token]) => !declared.has(token) && !external.has(token))
      .map(([token, files]) => `${token} referenced in ${[...new Set(files)].join(', ')}`);

    expect(dangling, 'these var() references resolve to nothing at runtime').toEqual([]);
  });

  it('the palette tokens a component can reference all live in :root', () => {
    // Scope files may override a token but must not be the only place it is
    // declared, or the other surface renders it as an unresolved var().
    const root = new Set(Object.keys(extractTokens(readFileSync(join(APP, 'globals.css'), 'utf8'), ':root')));
    const palette = ['--bg', '--surface', '--surface-2', '--border', '--border-strong', '--text', '--muted', '--accent', '--accent-ink', '--radius'];
    for (const token of palette) {
      expect(root.has(token), `${token} must have a :root default`).toBe(true);
    }
  });
});
