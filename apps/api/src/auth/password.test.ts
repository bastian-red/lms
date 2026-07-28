import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('hashPassword / verifyPassword', () => {
  it('round-trips', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects the wrong password', () => {
    expect(verifyPassword('nope', hashPassword('correct horse'))).toBe(false);
  });

  it('salts, so identical passwords do not produce identical hashes', () => {
    // Without a per-password salt, a stolen table is one rainbow lookup away
    // from every account that shared a password.
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects a malformed stored value instead of throwing', () => {
    for (const stored of ['', 'garbage', 'scrypt:onlyone', 'bcrypt:a:b', 'scrypt::', 'scrypt:a:']) {
      expect(verifyPassword('x', stored)).toBe(false);
    }
  });

  it('rejects a hash of the wrong length rather than crashing timingSafeEqual', () => {
    expect(verifyPassword('x', 'scrypt:abcd:00')).toBe(false);
  });
});
