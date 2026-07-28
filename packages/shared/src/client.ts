/**
 * The client-safe surface of `@lms/shared`.
 *
 * Identical to the default entry point minus `media/ticket`, which imports
 * `node:crypto` to compute the playback HMAC. That module is server-only by
 * nature — it holds the signing logic for the secret — and pulling it into a
 * browser bundle fails the Next build outright, which is the correct outcome:
 * the alternative is a bundler polyfill quietly shipping a crypto shim to
 * implement a signature the client has no business producing.
 *
 * Everything here is pure arithmetic and Zod schemas, so both sides genuinely
 * share one definition of a contract, one grading rule and one progress
 * calculation.
 */
export * from './analytics/dropoff';
export * from './auth/password-strength';
export * from './contracts';
export * from './progress/intervals';
export * from './quiz/grading';
