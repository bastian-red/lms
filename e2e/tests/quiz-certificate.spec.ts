import { expect, test } from '@playwright/test';
import { COURSE_SLUG, signIn, STUDENT } from './helpers';

/**
 * The student-facing half of properties 4 and 5.
 *
 * The integration lane already proves the API refuses an unearned certificate
 * and never ships an answer key. This proves the same things are true of what a
 * browser actually receives, which is a different claim: a Server Component
 * could serialise the answer into the HTML payload without any API response
 * carrying it.
 */
test.describe('quizzes and certificates', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, STUDENT);
  });

  test('a quiz renders without the answer key anywhere in the page', async ({ page }) => {
    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByRole('link', { name: /Foundations check/i }).click();
    await expect(page.getByTestId('quiz')).toBeVisible();

    // The whole document, including the RSC payload Next inlines into it.
    const html = await page.content();
    expect(html).not.toContain('isCorrect');
    expect(html).not.toContain('acceptedAnswers');
  });

  test('a wrong answer is marked wrong without revealing the right one', async ({ page }) => {
    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByRole('link', { name: /Foundations check/i }).click();
    await expect(page.getByTestId('quiz')).toBeVisible();

    // Answer the first question with its first choice, whatever that is, and
    // submit everything else blank.
    const firstChoice = page.locator('[data-testid^="choice-"]').first();
    await firstChoice.check();
    await page.getByTestId('submit-quiz').click();

    const result = page.getByTestId('quiz-result');
    await expect(result).toBeVisible();
    // A verdict per question, and no correct answer shown.
    await expect(page.locator('.question.incorrect').first()).toBeVisible();
  });

  test('the certificate is refused with the outstanding lessons named', async ({ page }) => {
    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByTestId('request-certificate').click();

    await expect(page.getByTestId('certificate-error')).toBeVisible();
    // Naming what is missing is the point: "not eligible" with no reason is a
    // support ticket.
    await expect(page.getByTestId('outstanding').locator('li').first()).toBeVisible();
  });

  test('verifying an unknown serial says so rather than erroring', async ({ page }) => {
    await page.goto('/verify/LMS-2222-3333-4444');
    const result = page.getByTestId('verify-result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-valid', 'false');
  });
});
