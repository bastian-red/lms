import { UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { AuthGuard, OptionalAuthGuard, type AuthedRequest } from './auth.guard';
import type { AppConfig } from '../config/config';

const SECRET = 'guard-test-secret-at-least-32-characters';
const config = { authSecret: SECRET } as AppConfig;

function context(authorization?: string): { ctx: never; request: AuthedRequest } {
  const request = { headers: authorization ? { authorization } : {} } as AuthedRequest;
  const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as never;
  return { ctx, request };
}

function token(payload: object, options: jwt.SignOptions = {}, secret = SECRET): string {
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '5m', ...options });
}

describe('AuthGuard', () => {
  it('accepts a valid service token and attaches the user', () => {
    const { ctx, request } = context(
      `Bearer ${token({ sub: 'u1', email: 'a@b.c', role: 'INSTRUCTOR' })}`,
    );
    expect(new AuthGuard(config).canActivate(ctx)).toBe(true);
    expect(request.user).toEqual({ id: 'u1', email: 'a@b.c', role: 'INSTRUCTOR' });
  });

  it('refuses a missing header', () => {
    expect(() => new AuthGuard(config).canActivate(context().ctx)).toThrow(UnauthorizedException);
  });

  it('refuses a non-bearer header', () => {
    expect(() => new AuthGuard(config).canActivate(context('Basic abc').ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a token signed with another secret', () => {
    const other = token({ sub: 'u1', role: 'ADMIN' }, {}, 'a-completely-different-secret-32chars');
    expect(() => new AuthGuard(config).canActivate(context(`Bearer ${other}`).ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an expired token', () => {
    const expired = token({ sub: 'u1', role: 'STUDENT' }, { expiresIn: '-1s' });
    expect(() => new AuthGuard(config).canActivate(context(`Bearer ${expired}`).ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses alg:none, the oldest JWT bypass there is', () => {
    // jsonwebtoken will not sign one, so it is assembled by hand — which is
    // exactly how an attacker would produce it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', role: 'ADMIN' })).toString('base64url');
    expect(() =>
      new AuthGuard(config).canActivate(context(`Bearer ${header}.${payload}.`).ctx),
    ).toThrow(UnauthorizedException);
  });

  it('refuses a token with no subject', () => {
    expect(() =>
      new AuthGuard(config).canActivate(context(`Bearer ${token({ role: 'ADMIN' })}`).ctx),
    ).toThrow(UnauthorizedException);
  });

  it('downgrades an unknown role to STUDENT rather than trusting it', () => {
    // Defaulting the other way would turn a malformed token into an admin.
    const { ctx, request } = context(`Bearer ${token({ sub: 'u1', role: 'SUPERUSER' })}`);
    new AuthGuard(config).canActivate(ctx);
    expect(request.user?.role).toBe('STUDENT');
  });

  it('downgrades a missing role to STUDENT', () => {
    const { ctx, request } = context(`Bearer ${token({ sub: 'u1' })}`);
    new AuthGuard(config).canActivate(ctx);
    expect(request.user?.role).toBe('STUDENT');
  });
});

describe('OptionalAuthGuard', () => {
  it('lets an anonymous request through with no user', () => {
    const { ctx, request } = context();
    expect(new OptionalAuthGuard(config).canActivate(ctx)).toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('attaches the user when a valid token is present', () => {
    const { ctx, request } = context(`Bearer ${token({ sub: 'u1', role: 'STUDENT' })}`);
    expect(new OptionalAuthGuard(config).canActivate(ctx)).toBe(true);
    expect(request.user?.id).toBe('u1');
  });

  it('still refuses a present-but-invalid token', () => {
    // Treating a forgery as "anonymous" would hide an attack behind a page that
    // renders normally.
    const forged = token({ sub: 'u1' }, {}, 'a-completely-different-secret-32chars');
    expect(() => new OptionalAuthGuard(config).canActivate(context(`Bearer ${forged}`).ctx)).toThrow(
      UnauthorizedException,
    );
  });
});
