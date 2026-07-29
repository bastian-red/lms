import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADMIN, COURSE_SLUG, INSTRUCTOR, signIn, STUDENT } from './helpers';

/**
 * Accessibility, measured rather than asserted by eye.
 *
 * A design change is otherwise unfalsifiable: "it looks better" is not a
 * result. axe-core turns most of it into a number — contrast, names, roles,
 * landmarks, label association — and this spec drives that number to zero and
 * keeps it there.
 *
 * Both colour schemes run because the palette is defined twice
 * (`prefers-color-scheme: light` overrides `:root`), so a token that passes in
 * dark can fail in light and nothing would catch it. Chromium and firefox both
 * run the file, which is redundant for axe's rule engine but free.
 *
 * Scope note: `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` only. Best-practice rules
 * are deliberately excluded — they flag stylistic preferences that are not
 * conformance failures, and a gate that fails on opinion gets disabled.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Set with BASELINE=1 to record findings instead of failing on them. */
const RECORDING = process.env.BASELINE === '1';
const BASELINE_DIR = process.env.BASELINE_DIR ?? '/tmp/lms-a11y';

type Scheme = 'light' | 'dark';
const SCHEMES: Scheme[] = ['light', 'dark'];

interface RouteCase {
  name: string;
  path: string;
  /** Who must be signed in for the route to render its real content. */
  as?: typeof STUDENT;
  /** Runs after navigation, for routes that need a click to reach the state. */
  prepare?: (page: Page) => Promise<void>;
}

/**
 * Every route that renders UI.
 *
 * `/api/*` is excluded: those return a PDF and an auth handler, not a document.
 */
const ROUTES: RouteCase[] = [
  { name: 'catalog (anonymous)', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'signup', path: '/signup' },
  { name: 'course detail (anonymous)', path: `/courses/${COURSE_SLUG}` },
  { name: 'verify (unknown serial)', path: '/verify/LMS-NOPE-0000' },
  { name: 'catalog (student)', path: '/', as: STUDENT },
  { name: 'my courses', path: '/my/courses', as: STUDENT },
  { name: 'course detail (enrolled)', path: `/courses/${COURSE_SLUG}`, as: STUDENT },
  {
    name: 'lesson player',
    path: `/courses/${COURSE_SLUG}`,
    as: STUDENT,
    prepare: async (page) => {
      await page.getByTestId('continue').click();
      await expect(page.getByTestId('lesson-video')).toBeVisible();
    },
  },
  {
    name: 'quiz',
    path: `/courses/${COURSE_SLUG}`,
    as: STUDENT,
    prepare: async (page) => {
      await page.getByRole('link', { name: /Foundations check/i }).click();
      await expect(page.getByTestId('quiz')).toBeVisible();
    },
  },
  {
    name: 'quiz graded',
    path: `/courses/${COURSE_SLUG}`,
    as: STUDENT,
    prepare: async (page) => {
      await page.getByRole('link', { name: /Foundations check/i }).click();
      await expect(page.getByTestId('quiz')).toBeVisible();
      // Submit empty: every question comes back wrong, which is the state that
      // has to stay legible. Grading an all-wrong attempt is the worst case for
      // a colour-only pass/fail signal.
      await page.getByTestId('submit-quiz').click();
      await expect(page.getByTestId('quiz-result')).toBeVisible();
    },
  },
  {
    name: 'certificate refused',
    path: `/courses/${COURSE_SLUG}`,
    as: STUDENT,
    prepare: async (page) => {
      await page.getByTestId('request-certificate').click();
      await expect(page.getByTestId('certificate-error')).toBeVisible();
    },
  },
  { name: 'instructor dashboard', path: '/instructor', as: INSTRUCTOR },
  {
    name: 'instructor course editor',
    path: '/instructor',
    as: INSTRUCTOR,
    prepare: async (page) => {
      await page.getByRole('link', { name: /Adaptive Video Streaming/i }).click();
      await expect(page.getByTestId('roster')).toBeVisible();
    },
  },
  { name: 'admin', path: '/admin', as: ADMIN },
];

const findings: Record<string, unknown> = {};

test.describe('accessibility', () => {
  for (const scheme of SCHEMES) {
    test.describe(`${scheme} scheme`, () => {
      test.use({ colorScheme: scheme });

      for (const route of ROUTES) {
        test(`${route.name} has no WCAG violations`, async ({ page }) => {
          if (route.as) await signIn(page, route.as);
          await page.goto(route.path);
          if (route.prepare) await route.prepare(page);

          const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();

          const summary = results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            nodes: violation.nodes.length,
            // One example is enough to find it; dumping every node makes the
            // baseline unreadable.
            example: violation.nodes[0]?.html?.slice(0, 200),
          }));

          if (RECORDING) {
            findings[`${scheme} :: ${route.name}`] = summary;
            test.info().annotations.push({
              type: 'baseline',
              description: `${summary.length} violation types`,
            });
            return;
          }

          expect(summary, `axe violations on ${route.name} (${scheme})`).toEqual([]);
        });
      }
    });
  }

  test.afterAll(async () => {
    if (!RECORDING) return;
    await mkdir(BASELINE_DIR, { recursive: true });
    await writeFile(
      join(BASELINE_DIR, 'baseline.json'),
      `${JSON.stringify(findings, null, 2)}\n`,
      'utf8',
    );
  });
});
