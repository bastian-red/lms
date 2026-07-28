import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, isObviousPassword, passwordSchema } from './password-strength';

describe('passwordSchema', () => {
  it('accepts a long passphrase', () => {
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  it('rejects anything under the length floor', () => {
    expect(passwordSchema.safeParse('a'.repeat(MIN_PASSWORD_LENGTH - 1)).success).toBe(false);
  });

  it('rejects the top of every credential-stuffing list', () => {
    for (const bad of ['password123', 'PASSWORD123', 'qwertyuiop']) {
      expect(passwordSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('bounds the length, because scrypt cost is linear in it', () => {
    expect(passwordSchema.safeParse('a'.repeat(5_000)).success).toBe(false);
  });

  it('is case-insensitive about the denylist', () => {
    expect(isObviousPassword('PaSsWoRd123')).toBe(true);
  });
});
