import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RolesGuard } from './roles.guard';

function context(user: unknown, required: unknown) {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    _required: required,
  } as never;
}

function guard(required: unknown) {
  const reflector = { getAllAndOverride: () => required } as never;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('allows a matching role', () => {
    expect(
      guard(['INSTRUCTOR']).canActivate(context({ id: 'u', role: 'INSTRUCTOR' }, ['INSTRUCTOR'])),
    ).toBe(true);
  });

  it('refuses a non-matching role', () => {
    expect(() =>
      guard(['ADMIN']).canActivate(context({ id: 'u', role: 'STUDENT' }, ['ADMIN'])),
    ).toThrow(ForbiddenException);
  });

  it('does not grant ADMIN every other role implicitly', () => {
    // An admin who is not the instructor of a course must not be able to edit
    // it just because they are an admin. Blanket superuser access is how an
    // accidental role assignment becomes a content breach.
    expect(() =>
      guard(['INSTRUCTOR']).canActivate(context({ id: 'u', role: 'ADMIN' }, ['INSTRUCTOR'])),
    ).toThrow(ForbiddenException);
  });

  it('fails closed when no roles are declared', () => {
    // A guard that permits when the decorator is missing does nothing the day
    // someone forgets it.
    expect(() => guard(undefined).canActivate(context({ id: 'u', role: 'ADMIN' }, undefined))).toThrow(
      ForbiddenException,
    );
    expect(() => guard([]).canActivate(context({ id: 'u', role: 'ADMIN' }, []))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a request with no user', () => {
    expect(() => guard(['STUDENT']).canActivate(context(undefined, ['STUDENT']))).toThrow(
      ForbiddenException,
    );
  });
});
