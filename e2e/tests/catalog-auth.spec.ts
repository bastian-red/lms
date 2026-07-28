import { expect, test } from '@playwright/test';
import { COURSE_SLUG, DEMO_PASSWORD, signIn, STUDENT } from './helpers';

test.describe('catalog and auth', () => {
  test('the catalog lists the seeded course', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('course-list')).toBeVisible();
    await expect(page.getByRole('link', { name: /Adaptive Video Streaming/i })).toBeVisible();
  });

  test('an anonymous visitor sees the syllabus but is prompted to sign in', async ({ page }) => {
    await page.goto(`/courses/${COURSE_SLUG}`);
    await expect(page.getByTestId('syllabus')).toBeVisible();
    await expect(page.getByRole('link', { name: /Sign in to enroll/i })).toBeVisible();
  });

  test('signing in shows the student their progress on the course page', async ({ page }) => {
    await signIn(page, STUDENT);
    await page.goto(`/courses/${COURSE_SLUG}`);
    await expect(page.getByTestId('course-progress')).toBeVisible();
    await expect(page.getByTestId('continue')).toBeVisible();
  });

  test('a wrong password is refused with one generic message', async ({ page }) => {
    // The message must not distinguish "no such account" from "wrong password":
    // that difference is an account-enumeration oracle.
    await page.goto('/login');
    await page.getByTestId('email').fill(STUDENT.email);
    await page.getByTestId('password').fill('definitely-not-the-password');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-error')).toContainText(/invalid email or password/i);

    await page.getByTestId('email').fill('nobody-at-all@lms.local');
    await page.getByTestId('password').fill('definitely-not-the-password');
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-error')).toContainText(/invalid email or password/i);
  });

  test('a new student can sign up, enroll and reach a lesson', async ({ page }) => {
    const email = `student-${Date.now()}@lms.local`;

    await page.goto('/signup');
    await page.getByTestId('name').fill('New Student');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('password').fill(DEMO_PASSWORD);
    // The strength meter reflects the same length policy the server enforces.
    await expect(page.getByTestId('strength-label')).not.toBeEmpty();
    await page.getByTestId('auth-submit').click();
    await page.waitForURL('**/my/courses', { timeout: 30_000 });

    await page.goto(`/courses/${COURSE_SLUG}`);
    await page.getByTestId('enroll').click();
    await expect(page.getByTestId('continue')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('continue').click();
    await expect(page.getByTestId('lesson-video')).toBeVisible();
  });

  test('a short password is refused by the shared policy', async ({ page }) => {
    await page.goto('/signup');
    await page.getByTestId('name').fill('Too Short');
    await page.getByTestId('email').fill(`short-${Date.now()}@lms.local`);
    await page.getByTestId('password').fill('short');
    // The browser's own minLength blocks submission, which is the same rule the
    // server enforces rather than a second opinion about it.
    await expect(page.getByTestId('password')).toHaveAttribute('minlength', '10');
  });
});
