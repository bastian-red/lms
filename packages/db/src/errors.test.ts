import { describe, expect, it } from 'vitest';
import {
  isCheckViolation,
  isDuplicateCertificate,
  isDuplicateLiveJob,
  isUniqueViolation,
} from './index';

/**
 * These guards decide whether a failure is a race to absorb or a bug to
 * surface, and they get it wrong silently. The certificate race is the concrete
 * case: a guard keyed on the Postgres SQLSTATE never fires against Prisma's
 * typed client, so ten concurrent requests produce nine 500s and — worse, if
 * the guard had been written the other way round — two certificates.
 */
describe('isUniqueViolation', () => {
  it('recognises Prisma\'s own code, which is what `create()` throws', () => {
    expect(isUniqueViolation({ code: 'P2002', meta: { target: ['enrollment_id'] } })).toBe(true);
  });

  it('recognises the Postgres SQLSTATE, which is what $queryRaw throws', () => {
    expect(isUniqueViolation({ code: '23505', meta: { constraint: 'anything' } })).toBe(true);
  });

  it('is false for an unrelated error', () => {
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('can require a specific constraint', () => {
    const error = { code: 'P2002', meta: { target: ['enrollment_id'] } };
    expect(isUniqueViolation(error, 'enrollment_id')).toBe(true);
    expect(isUniqueViolation(error, 'serial')).toBe(false);
  });
});

describe('isDuplicateCertificate', () => {
  it('matches the column name Prisma actually reports', () => {
    expect(isDuplicateCertificate({ code: 'P2002', meta: { target: ['enrollment_id'] } })).toBe(
      true,
    );
  });

  it('matches the model field name too, since Prisma versions differ', () => {
    expect(isDuplicateCertificate({ code: 'P2002', meta: { target: ['enrollmentId'] } })).toBe(true);
  });

  it('does not match a different unique constraint on the same table', () => {
    // A duplicate serial is a generator collision, not a lost race, and must
    // not be swallowed as "already issued".
    expect(isDuplicateCertificate({ code: 'P2002', meta: { target: ['serial'] } })).toBe(false);
  });
});

describe('isDuplicateLiveJob', () => {
  it('matches the raw-SQL partial index by name', () => {
    expect(
      isDuplicateLiveJob({
        code: 'P2002',
        meta: { target: 'transcode_jobs_one_live_per_asset' },
      }),
    ).toBe(true);
  });

  it('does not match an unrelated unique violation', () => {
    expect(isDuplicateLiveJob({ code: 'P2002', meta: { target: ['id'] } })).toBe(false);
  });
});

describe('isCheckViolation', () => {
  it('recognises the Postgres SQLSTATE', () => {
    expect(isCheckViolation({ code: '23514', meta: { constraint: 'x' } })).toBe(true);
  });

  it('is false for a unique violation', () => {
    expect(isCheckViolation({ code: 'P2002' })).toBe(false);
  });
});
