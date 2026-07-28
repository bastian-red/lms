import { expect, test, type Page } from '@playwright/test';
import { INSTRUCTOR, openEnrolledOnlyLesson, signIn, STUDENT, waitForPlayback } from './helpers';

/**
 * Property 2, proven in a browser: **revocation stops playback immediately**.
 *
 * A student is watching. An instructor revokes them. The student's browser still
 * holds a cryptographically valid ticket, minutes from expiry, and it still
 * cannot fetch the key — so the next segment it needs will not decrypt.
 *
 * Deliberately not the course's first lesson: that one is the free preview,
 * which anyone signed in may watch whether or not they are enrolled. Pointing a
 * revocation test at it shows the video happily continuing and reads as a
 * broken mechanism when the mechanism is doing exactly its job.
 *
 * The integration lane proves the endpoint returns 403. This proves the thing
 * that matters to a person: the video stops, and it stops because of the key,
 * not because of anything the client chose to enforce.
 */
test.describe('revoking access mid-playback', () => {
  test.afterEach(async ({ browser }) => {
    // Always put the student back, whatever the test did. A left-revoked
    // enrollment would break every spec that runs after this one.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await reinstateStudent(page);
    } finally {
      await context.close();
    }
  });

  test('the key is refused the moment access is revoked, ticket still valid', async ({
    browser,
  }) => {
    const studentContext = await browser.newContext();
    const studentPage = await studentContext.newPage();
    const instructorContext = await browser.newContext();
    const instructorPage = await instructorContext.newPage();

    try {
      // 1. The student is watching, and the browser has fetched a key.
      await signIn(studentPage, STUDENT);
      await openEnrolledOnlyLesson(studentPage);
      await waitForPlayback(studentPage, 2);

      const keyUrl = await studentPage.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => name.includes('/key?')),
      );
      expect(keyUrl, 'the player must have fetched an AES key').toBeTruthy();

      // The same URL works right now.
      const before = await studentPage.evaluate(
        async (url) => (await fetch(url)).status,
        keyUrl!,
      );
      expect(before).toBe(200);

      // 2. The instructor revokes them.
      await signIn(instructorPage, INSTRUCTOR);
      await revokeStudent(instructorPage);

      // 3. The very same ticket, seconds later, is refused.
      await expect
        .poll(
          async () => studentPage.evaluate(async (url) => (await fetch(url)).status, keyUrl!),
          { timeout: 20_000, message: 'the key endpoint kept serving a revoked student' },
        )
        .toBe(403);

      // And so is a fresh manifest, so the player cannot recover by reloading.
      await studentPage.reload();
      await expect(studentPage.getByTestId('access-denied')).toBeVisible({ timeout: 30_000 });
    } finally {
      await studentContext.close();
      await instructorContext.close();
    }
  });

  test('reinstating restores playback', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(page, INSTRUCTOR);
      await revokeStudent(page);
      await reinstateStudent(page);

      const studentContext = await browser.newContext();
      const studentPage = await studentContext.newPage();
      try {
        await signIn(studentPage, STUDENT);
        await openEnrolledOnlyLesson(studentPage);
        await waitForPlayback(studentPage, 2);
      } finally {
        await studentContext.close();
      }
    } finally {
      await context.close();
    }
  });
});

/**
 * Revoke through the instructor's own API, using the session the browser
 * already holds.
 *
 * Deliberately not a direct database write: doing it the way the product does
 * it means this test also covers the roster route, the ownership check and the
 * revoke endpoint, rather than only the key endpoint's behaviour.
 */
async function revokeStudent(instructorPage: Page): Promise<void> {
  await openRoster(instructorPage);
  const id = await enrollmentIdFor(instructorPage);
  await instructorPage.getByTestId(`revoke-${id}`).click();
  await expect(
    instructorPage.getByTestId(`roster-${STUDENT.email}`).getByText('REVOKED'),
  ).toBeVisible({ timeout: 30_000 });
}

async function reinstateStudent(page: Page): Promise<void> {
  await signIn(page, INSTRUCTOR);
  await openRoster(page);
  const id = await enrollmentIdFor(page);
  const button = page.getByTestId(`reinstate-${id}`);
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await expect(page.getByTestId(`revoke-${id}`)).toBeVisible({ timeout: 30_000 });
  }
}

async function openRoster(page: Page): Promise<void> {
  await page.goto('/instructor');
  await page.getByRole('link', { name: /Adaptive Video Streaming/i }).click();
  await expect(page.getByTestId('roster')).toBeVisible();
}

/** Read the student's enrollment id off the rendered roster row. */
async function enrollmentIdFor(page: Page): Promise<string> {
  const id = await page
    .getByTestId(`roster-${STUDENT.email}`)
    .getAttribute('data-enrollment-id');
  expect(id, `no roster row for ${STUDENT.email}`).toBeTruthy();
  return id!;
}
