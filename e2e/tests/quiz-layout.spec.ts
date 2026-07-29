import { expect, test } from '@playwright/test';
import { COURSE_SLUG, signIn, STUDENT } from './helpers';

/**
 * The quiz was the screen the inherited design language hurt most, and none of
 * it showed up as a test failure. Three separate defects, all invisible to the
 * 48 tests that were already passing:
 *
 * 1. `.choice` is a `<label>`, so it inherited the global `label` rule and
 *    rendered every answer in dim uppercase mono. Uppercase costs roughly a
 *    tenth of reading speed because it destroys word shape, and comparing
 *    options *is* the task on this screen.
 *
 * 2. The global `input { width: 100% }` applied to the radio and checkbox
 *    controls, so each one stretched across the row and shoved its answer text
 *    to the far right, with the control floating in the middle of the gap.
 *
 * 3. Correct and incorrect were signalled only by a coloured left border, and
 *    `--ok` resolved to plain white in dark mode and plain black in light. The
 *    feedback was literally the same colour as ordinary chrome.
 *
 * Geometry and computed style are exactly the kind of thing a human reviewer
 * stops checking after the first week, so they are asserted here instead.
 */
test.describe('quiz legibility', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, STUDENT);
    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByRole('link', { name: /Foundations check/i }).click();
    await expect(page.getByTestId('quiz')).toBeVisible();
  });

  test('answers read as sentences, not as uppercase mono labels', async ({ page }) => {
    const choice = page.locator('.choice').first();
    await expect(choice).toBeVisible();

    const style = await choice.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        textTransform: computed.textTransform,
        fontFamily: computed.fontFamily,
        letterSpacing: computed.letterSpacing,
        fontSize: Number.parseFloat(computed.fontSize),
      };
    });

    expect(style.textTransform, 'answers must not be uppercased').toBe('none');
    expect(style.fontFamily.toLowerCase(), 'answers use the body face, not mono').not.toMatch(
      /mono/,
    );
    // 'normal' or a value at/near zero; the old rule applied 0.1em.
    const tracking = style.letterSpacing === 'normal' ? 0 : Number.parseFloat(style.letterSpacing);
    expect(tracking, 'answers must not be letter-spaced').toBeLessThan(0.5);
    expect(style.fontSize, 'answers must be readable body size').toBeGreaterThanOrEqual(14);
  });

  test('the control sits beside its answer, not stretched across the row', async ({ page }) => {
    const choice = page.locator('.choice').first();
    const control = choice.locator('input');

    const controlBox = await control.boundingBox();
    const choiceBox = await choice.boundingBox();
    expect(controlBox, 'the choice must contain a control').not.toBeNull();
    expect(choiceBox).not.toBeNull();

    // The bug: `width: 100%` made the control as wide as its row.
    expect(
      controlBox!.width,
      'the radio/checkbox must not stretch to the row width',
    ).toBeLessThan(choiceBox!.width / 2);
    expect(controlBox!.width, 'the control should be a control-sized box').toBeLessThan(40);

    // And the text must start to the right of it, not be pushed past it.
    const textBox = await choice.locator('span').first().boundingBox();
    expect(textBox).not.toBeNull();
    expect(
      textBox!.x,
      'the answer text must sit to the right of the control',
    ).toBeGreaterThan(controlBox!.x);
    // Left-aligned near the control rather than flung to the far edge.
    expect(textBox!.x - (controlBox!.x + controlBox!.width)).toBeLessThan(40);
  });

  test('the whole choice row is a click target of usable size', async ({ page }) => {
    const box = await page.locator('.choice').first().boundingBox();
    expect(box!.height, 'a choice row must clear the 44px target floor').toBeGreaterThanOrEqual(44);
  });

  test('grading says correct or incorrect in words, not only in colour', async ({ page }) => {
    // Submitting empty grades every question wrong, which is the state that has
    // to survive greyscale.
    await page.getByTestId('submit-quiz').click();
    await expect(page.getByTestId('quiz-result')).toBeVisible();

    const wrong = page.locator('.question.incorrect').first();
    await expect(wrong).toBeVisible();

    // The class is still there — quiz-certificate.spec.ts locates on it — but it
    // is no longer the only channel.
    const verdict = wrong.locator('.verdict');
    await expect(verdict).toBeVisible();
    await expect(verdict).toHaveText(/incorrect/i);

    // And the colour is a real state colour, not the body text colour, which is
    // what --ok used to resolve to.
    const colours = await wrong.evaluate((element) => {
      const badge = element.querySelector('.verdict') as HTMLElement;
      return {
        verdict: getComputedStyle(badge).color,
        body: getComputedStyle(document.body).color,
      };
    });
    expect(colours.verdict, 'the verdict must not be plain body colour').not.toBe(colours.body);
  });
});
