import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'course-demo-password';
export const STUDENT = { email: 'ada@lms.local', password: DEMO_PASSWORD };
export const INSTRUCTOR = { email: 'grace@lms.local', password: DEMO_PASSWORD };
export const ADMIN = { email: 'admin@lms.local', password: DEMO_PASSWORD };

export const COURSE_SLUG = 'adaptive-video-streaming';

export async function signIn(
  page: Page,
  who: { email: string; password: string },
): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('email').fill(who.email);
  await page.getByTestId('password').fill(who.password);
  await page.getByTestId('auth-submit').click();
  // The redirect target proves the session was actually established; asserting
  // on a UI element could pass against a page that merely re-rendered.
  await page.waitForURL('**/my/courses', { timeout: 30_000 });
}

export async function signOut(page: Page): Promise<void> {
  const button = page.getByTestId('sign-out');
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  }
}

/**
 * The seeded course's free preview lesson.
 *
 * Watchable by anyone signed in, enrolled or not, which is exactly why it is
 * the wrong lesson for any test about access control.
 */
export const PREVIEW_LESSON = 'Why adaptive streaming exists';

/**
 * A lesson that genuinely requires an active enrollment.
 *
 * The distinction matters and cost a debugging session: "Continue" opens the
 * first lesson of the course, which is the free preview, so a revocation test
 * pointed at it watches the video keep playing and concludes the mechanism is
 * broken when it is working exactly as designed.
 */
export const ENROLLED_ONLY_LESSON = 'Designing a bitrate ladder';

/** Open the free preview lesson. */
export async function openPreviewLesson(page: Page): Promise<void> {
  await page.goto(`/courses/${COURSE_SLUG}`);
  await page.getByTestId('continue').click();
  await expect(page.getByTestId('lesson-video')).toBeVisible();
}

/** Open a lesson that only an enrolled student may watch. */
export async function openEnrolledOnlyLesson(page: Page): Promise<void> {
  await page.goto(`/courses/${COURSE_SLUG}`);
  await page.getByRole('link', { name: ENROLLED_ONLY_LESSON }).click();
  await expect(page.getByTestId('lesson-video')).toBeVisible();
}

/**
 * Wait until the player has actually decrypted and rendered frames.
 *
 * `readyState >= 2` means HAVE_CURRENT_DATA: the browser has a decoded frame in
 * hand. That is the only assertion that proves the whole chain worked — ticket,
 * playlist rewrite, segment fetch, key fetch, AES-128 decrypt — because none of
 * it produces a frame if any link is broken.
 */
export async function waitForPlayback(page: Page, seconds = 3): Promise<void> {
  const video = page.getByTestId('lesson-video');
  await video.evaluate((element) => (element as HTMLVideoElement).play());
  await expect
    .poll(
      async () =>
        video.evaluate((element) => {
          const media = element as HTMLVideoElement;
          return media.readyState >= 2 ? media.currentTime : -1;
        }),
      { timeout: 60_000, message: 'the player never produced a decoded frame' },
    )
    .toBeGreaterThan(seconds);
}
