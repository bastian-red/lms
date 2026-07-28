import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ROLES, type Role } from '@lms/shared';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { CONFIG, type AppConfig } from '../config/config';

export interface ServiceTokenPayload {
  /** User id. */
  sub: string;
  email: string;
  role: Role;
}

export interface AuthedRequest extends Request {
  user?: { id: string; email: string; role: Role };
}

/**
 * Verifies the short-lived HS256 service token the web app mints from the shared
 * AUTH_SECRET, and attaches the user to the request.
 *
 * The web app owns the Auth.js session cookie; the API never sees it. That split
 * means the API has no session store, no cookie parsing and no CSRF surface: it
 * only ever accepts a bearer token it can verify with a secret it already holds.
 *
 * `algorithms: ['HS256']` is not decoration. Without it, a token with
 * `"alg": "none"` verifies against any secret, which is the oldest JWT bypass
 * there is.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    try {
      const payload = jwt.verify(header.slice('Bearer '.length), this.config.authSecret, {
        algorithms: ['HS256'],
      }) as ServiceTokenPayload;
      if (!payload.sub) throw new Error('token has no subject');
      request.user = {
        id: payload.sub,
        email: payload.email,
        // An unrecognised or missing role is treated as a student. Defaulting
        // the other way would turn a malformed token into an admin.
        role: ROLES.includes(payload.role) ? payload.role : 'STUDENT',
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}

/**
 * Same verification, but for a route that works signed in *and* signed out.
 *
 * The course detail page is the case: an anonymous visitor sees the syllabus, a
 * signed-in one additionally sees their enrollment and progress. Using the
 * strict guard would force the web app to make two different calls for one page,
 * and using no guard would mean the enrollment lookup has no user to key on.
 *
 * A present-but-invalid token is still rejected. Silently treating a forged
 * token as "anonymous" would hide an attack behind a working page.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return true;
    try {
      const payload = jwt.verify(header.slice('Bearer '.length), this.config.authSecret, {
        algorithms: ['HS256'],
      }) as ServiceTokenPayload;
      if (!payload.sub) throw new Error('token has no subject');
      request.user = {
        id: payload.sub,
        email: payload.email,
        role: ROLES.includes(payload.role) ? payload.role : 'STUDENT',
      };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    return true;
  }
}
