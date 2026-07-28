import { expect, test } from '@playwright/test';
import {
  COURSE_SLUG,
  openEnrolledOnlyLesson,
  openPreviewLesson,
  signIn,
  STUDENT,
  waitForPlayback,
} from './helpers';

/**
 * The property this file exists for: **encrypted video actually plays**.
 *
 * Every other test in the repo proves something is refused. This one proves the
 * legitimate path works end to end in a real browser — ticket minted, master
 * playlist rewritten, media playlist rewritten, segments fetched, key fetched,
 * AES-128 decrypted, frames decoded. A single decoded frame is the only
 * evidence that the whole chain is correct, because nothing renders if any link
 * is wrong.
 */
test.describe('encrypted adaptive playback', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, STUDENT);
  });

  test('an enrolled student watches an AES-128 encrypted lesson', async ({ page }) => {
    await openEnrolledOnlyLesson(page);
    await waitForPlayback(page, 2);

    // The player reports which rung it settled on, which is the adaptive ladder
    // made visible.
    await expect(page.getByTestId('rendition-readout')).toBeVisible();
  });

  test('the segments the browser fetched were encrypted, and the key came separately', async ({
    page,
  }) => {
    const segmentUrls: string[] = [];
    const keyUrls: string[] = [];

    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/segment/')) segmentUrls.push(url);
      if (url.includes('/key?')) keyUrls.push(url);
    });

    await openEnrolledOnlyLesson(page);
    await waitForPlayback(page, 2);

    // The key is a separate, authenticated request. If it were embedded in the
    // playlist, this would be empty and the video would still play — which is
    // exactly the failure this asserts against.
    expect(keyUrls.length).toBeGreaterThan(0);
    expect(segmentUrls.length).toBeGreaterThan(0);

    // Every media URL carries a ticket. A segment URL without one would mean
    // the rewrite was skipped and the path is open.
    for (const url of [...segmentUrls, ...keyUrls]) {
      expect(url).toContain('t=');
    }

    // Fetch a segment the browser just played and confirm the bytes are not a
    // transport stream. 0x47 is the MPEG-TS sync byte.
    const firstByte = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes[0];
    }, segmentUrls[0]!);
    expect(firstByte).not.toBe(0x47);
  });

  test('progress accrues while watching and survives a reload', async ({ page }) => {
    await openEnrolledOnlyLesson(page);
    await waitForPlayback(page, 2);

    // The first heartbeat lands ten seconds in.
    await expect
      .poll(async () => Number(await page.getByTestId('seconds-watched').innerText()), {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);

    const before = Number(await page.getByTestId('seconds-watched').innerText());
    await page.reload();
    await expect(page.getByTestId('lesson-video')).toBeVisible();
    const after = Number(await page.getByTestId('seconds-watched').innerText());
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('the free preview plays too, so the funnel works', async ({ page }) => {
    await openPreviewLesson(page);
    await waitForPlayback(page, 2);
  });

  test('an anonymous visitor cannot open a lesson', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/learn/${COURSE_SLUG}/whatever`);
    await expect(page).toHaveURL(/\/login/);
  });
});
