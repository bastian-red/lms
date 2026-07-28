import { z } from 'zod';

/**
 * One password policy, shared by the signup form and the API.
 *
 * Two definitions of "strong enough" drift, and the one that drifts is always
 * the server's, so the browser accepts a password the API then rejects with a
 * 400 the form has no field to attach.
 *
 * The rules are length-first on purpose. Composition rules (a symbol, a digit,
 * a capital) push people toward `Password1!` and measurably do not help; length
 * does. 10 characters is the floor, and anything obviously guessable is refused
 * outright.
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * A short denylist of the passwords that actually show up in credential-stuffing
 * lists at the top of the distribution. Not a substitute for a breach-corpus
 * check; it is the cheap 90% that needs no network call.
 */
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd123',
  '1234567890',
  '12345678901',
  'qwertyuiop',
  'letmein123',
  'iloveyou123',
  'administrator',
  'welcome123',
  'changeme123',
]);

export function isObviousPassword(password: string): boolean {
  return OBVIOUS_PASSWORDS.has(password.toLowerCase());
}

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  // Bounded because scrypt's cost is linear in input length: an unbounded field
  // is a free CPU-exhaustion endpoint.
  .max(MAX_PASSWORD_LENGTH, 'That password is too long.')
  .refine((value) => !isObviousPassword(value), {
    message: 'That password is too common. Pick something else.',
  });
