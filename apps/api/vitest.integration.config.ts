import { defineConfig } from 'vitest/config';

// Integration lane: needs a real Postgres, a real Redis and a real ffmpeg.
// These tests are the proof of the five properties in the README, so they run
// serially against real infrastructure rather than against mocks. Transcoding a
// short clip takes seconds, hence the generous timeouts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
