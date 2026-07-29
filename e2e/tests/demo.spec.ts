import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { COURSE_SLUG, INSTRUCTOR, signIn, STUDENT, waitForPlayback } from './helpers';

/**
 * The README's demo GIF, recorded from the real suite.
 *
 * Tagged `@demo` and excluded by `grepInvert` in playwright.config.ts, because
 * it is slowed down on purpose and writes files. `scripts/demo-gif.sh` sets
 * DEMO=1 to let it through.
 *
 * It drives the app through the same helpers and selectors the rest of the
 * suite uses. That is the point: the demo cannot show a flow the tests do not
 * cover, and it breaks loudly when the product does.
 */
const SHOTS = join(__dirname, '..', 'demo-shots');
let frame = 0;

test.describe('@demo', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the whole story in one pass', async ({ page }) => {
    await mkdir(SHOTS, { recursive: true });

    const shot = async (name: string): Promise<void> => {
      frame += 1;
      await page.screenshot({
        path: join(SHOTS, `${String(frame).padStart(2, '0')}-${name}.png`),
      });
    };

    // 1. The catalogue.
    await page.goto('/');
    await expect(page.getByTestId('course-list')).toBeVisible();

    // The GIF is the first thing anyone sees in the README, so it must show the
    // seeded course and nothing else. Leftovers from the authoring spec once
    // reached it — two "E2E course 1785334738378" cards, served from Next's
    // fetch cache after the seed had already deleted them from the database.
    // The page was stale, not the data, which is why nothing else caught it.
    await expect(
      page.locator('.course-card'),
      'the demo must show only seeded courses',
    ).toHaveCount(1);
    await expect(page.getByText(/E2E course/)).toHaveCount(0);

    await shot('catalog');

    // 2. Sign in as the student.
    await signIn(page, STUDENT);

    // 3. The course page: syllabus and progress.
    await page.goto(`/courses/${COURSE_SLUG}`);
    await expect(page.getByTestId('syllabus')).toBeVisible();
    await shot('course');

    // 4. Encrypted video playing, with the rendition readout visible.
    await page.getByTestId('continue').click();
    await expect(page.getByTestId('lesson-video')).toBeVisible();
    await waitForPlayback(page, 3);
    await shot('player');

    // 5. A quiz, rendered without its answer key.
    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByRole('link', { name: /Foundations check/i }).click();
    await expect(page.getByTestId('quiz')).toBeVisible();
    await shot('quiz');

    // 6. The certificate refusal, naming what is outstanding.
    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByTestId('request-certificate').click();
    await expect(page.getByTestId('certificate-error')).toBeVisible();
    await shot('certificate-blocked');

    // 7. The instructor's retention charts and roster.
    await page.getByTestId('sign-out').click();
    await signIn(page, INSTRUCTOR);
    await page.goto('/instructor');
    await page.getByRole('link', { name: /Adaptive Video Streaming/i }).click();

    // Scrolled into view before the shot. `toBeVisible()` is satisfied by an
    // element below the fold, so a screenshot taken on that assertion alone
    // shows the top of the page and none of the thing being demonstrated.
    const charts = page.getByTestId('retention-charts');
    await charts.scrollIntoViewIfNeeded();
    await expect(charts).toBeVisible();
    await shot('analytics');

    const roster = page.getByTestId('roster');
    await roster.scrollIntoViewIfNeeded();
    await expect(roster).toBeVisible();
    await shot('roster');
  });
});
