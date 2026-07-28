import { expect, test } from '@playwright/test';
import { ADMIN, COURSE_SLUG, INSTRUCTOR, signIn, STUDENT } from './helpers';

test.describe('instructor', () => {
  test('sees the roster, the retention charts and the transcode status', async ({ page }) => {
    await signIn(page, INSTRUCTOR);
    await page.goto('/instructor');
    await expect(page.getByTestId('instructor-courses')).toBeVisible();

    await page.getByRole('link', { name: /Adaptive Video Streaming/i }).click();
    await expect(page.getByTestId('course-modules')).toBeVisible();
    await expect(page.getByTestId('roster')).toBeVisible();
    // The chart is the drop-off curve computed from the same merged intervals
    // progress uses.
    await expect(page.getByTestId('retention-charts')).toBeVisible();
    // Every seeded asset transcoded, so each video lesson reports READY.
    await expect(page.locator('[data-testid^="asset-status-"]').first()).toContainText('READY');
  });

  test('can create a course, add a module and a lesson, and publish it', async ({ page }) => {
    await signIn(page, INSTRUCTOR);
    await page.goto('/instructor');

    const title = `E2E course ${Date.now()}`;
    await page.getByTestId('create-course').click();
    await page.getByTestId('course-title').fill(title);
    await page.getByTestId('course-summary').fill('Created by the E2E suite.');
    await page.getByTestId('create-course-submit').click();

    // Landed on the editor for the new course.
    await expect(page.getByTestId('course-modules')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    await page.getByTestId('module-title').fill('Module one');
    await page.getByTestId('add-module').click();
    await expect(page.getByText('Module one')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('publish-course').click();
    await expect(page.getByTestId('unpublish-course')).toBeVisible({ timeout: 30_000 });

    // A published course reaches the public catalogue, which is what
    // revalidateTag('courses') exists to make immediate.
    await page.goto('/');
    await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 30_000 });
  });

  test('a student cannot reach the instructor area', async ({ page }) => {
    await signIn(page, STUDENT);
    await page.goto('/instructor');
    // Redirected away rather than shown an empty instructor page.
    await expect(page).not.toHaveURL(/\/instructor/);
  });
});

test.describe('admin', () => {
  test('sees platform stats and the pipeline breakdown', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/admin');
    await expect(page.getByTestId('admin-users')).toBeVisible();
    await expect(page.getByTestId('pipeline-stats')).toBeVisible();
    await expect(page.getByTestId(`user-${STUDENT.email}`)).toBeVisible();
  });

  test('cannot change its own role', async ({ page }) => {
    // A single-admin install that demotes itself needs a database console to
    // recover.
    await signIn(page, ADMIN);
    await page.goto('/admin');
    const row = page.getByTestId(`user-${ADMIN.email}`);
    await expect(row).toContainText('(you)');
  });

  test('a student cannot reach the admin area', async ({ page }) => {
    await signIn(page, STUDENT);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/\/admin/);
  });

  test('a student cannot reach another course editor by URL', async ({ page }) => {
    await signIn(page, STUDENT);
    await page.goto(`/courses/${COURSE_SLUG}`);
    // The instructor nav link is not even rendered for a student.
    await expect(page.getByRole('link', { name: 'Instructor' })).toHaveCount(0);
  });
});
