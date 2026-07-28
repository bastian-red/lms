import { defineConfig } from 'vitest/config';

// Gate lane. Only the error-classification helpers are unit tested here; they
// are pure functions over an error shape and need no database.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
