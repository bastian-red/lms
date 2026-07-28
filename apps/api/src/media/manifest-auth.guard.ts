import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ROLES, type Role } from '@lms/shared';
import jwt from 'jsonwebtoken';
import { CONFIG, type AppConfig } from '../config/config';
import type { AuthedRequest, ServiceTokenPayload } from '../auth/auth.guard';

/**
 * AuthGuard, plus a `?token=` fallback. Used on the manifest route and nowhere
 * else.
 *
 * Safari plays HLS natively through the `<video>` element, which is the only
 * way to get HLS on iOS at all. That element issues its own request for the
 * manifest and offers no hook to attach a header to it, so a bearer-header-only
 * manifest route is a manifest route that does not work on any iPhone.
 *
 * The fallback is deliberately confined:
 *   - Only this route accepts it. Every other authenticated route stays
 *     header-only, so a token in a URL cannot be replayed against, say, the
 *     admin API.
 *   - The token minted for it lives five minutes, like every other service
 *     token.
 *   - The response is `Cache-Control: no-store`, so a shared cache cannot hand
 *     one user's manifest — and the ticket inside it — to another.
 *
 * The header is checked first, so the ordinary hls.js path never depends on
 * this.
 */
@Injectable()
export class ManifestAuthGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const fromHeader = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const fromQuery = typeof request.query?.token === 'string' ? request.query.token : null;
    const raw = fromHeader ?? fromQuery;

    if (!raw) throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = jwt.verify(raw, this.config.authSecret, {
        algorithms: ['HS256'],
      }) as ServiceTokenPayload;
      if (!payload.sub) throw new Error('token has no subject');
      request.user = {
        id: payload.sub,
        email: payload.email,
        role: ROLES.includes(payload.role) ? payload.role : ('STUDENT' as Role),
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
