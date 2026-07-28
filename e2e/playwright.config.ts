import { defineConfig, devices } from '@playwright/test';

const WEB_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  // Serial on purpose. The specs share one seeded student and one course, and
  // the revocation spec deliberately takes access away mid-run; a parallel
  // student spec would fail for reasons that have nothing to do with the code.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  // Generous: several specs play real video through a real HLS pipeline.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // The demo spec writes screenshot frames for the README GIF and is slowed
  // down on purpose, so the normal suite skips it. scripts/demo-gif.sh sets
  // DEMO=1 to let it through. A CLI --grep cannot override grepInvert, which is
  // why this is an env check rather than a constant.
  grepInvert: process.env.DEMO ? undefined : /@demo/,
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Autoplay is blocked without it, and every video spec would time out
    // waiting for a `play` that the browser silently refused.
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  // The stack (web, api, worker, postgres, redis) is started before this runs:
  // by scripts/e2e.sh locally, by the workflow in CI.
});
