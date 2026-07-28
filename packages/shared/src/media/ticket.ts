import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Playback tickets.
 *
 * A ticket is a signed, short-lived, non-transferable permit to fetch the parts
 * of one lesson's HLS stream. It exists because the video player is not a place
 * a bearer token can go: hls.js issues its own requests for the media playlist,
 * for every segment, and for the decryption key, and there is no supported way
 * to attach an Authorization header to all of them across browsers.
 *
 * So the credential travels in the URL, which means it must be safe to appear
 * there:
 *   - It is bound to a user AND a lesson, so a leaked URL is worth nothing to
 *     another account and nothing on another lesson.
 *   - It expires in minutes.
 *   - It is verified with a constant-time compare.
 *   - It grants access to encrypted bytes only. The key endpoint additionally
 *     re-reads the enrollment, which is what makes a revocation take effect
 *     mid-playback instead of at the ticket's expiry.
 *
 * Deliberately not a JWT: the payload is three fields, the algorithm must never
 * be negotiable, and the `alg: none` family of bugs is worth designing out
 * rather than configuring away.
 */

export interface TicketClaims {
  /** User id. */
  sub: string;
  /** Lesson id. */
  lid: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export const DEFAULT_TICKET_TTL_MINUTES = 120;

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

/** Mint a ticket for one user on one lesson. */
export function issueTicket(
  userId: string,
  lessonId: string,
  secret: string,
  ttlMinutes: number = DEFAULT_TICKET_TTL_MINUTES,
  now: Date = new Date(),
): string {
  const claims: TicketClaims = {
    sub: userId,
    lid: lessonId,
    exp: Math.floor(now.getTime() / 1000) + Math.max(1, Math.floor(ttlMinutes * 60)),
  };
  const payload = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

export type TicketFailure =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'wrong-lesson'
  | 'wrong-user';

export type TicketVerification =
  | { ok: true; claims: TicketClaims }
  | { ok: false; reason: TicketFailure };

/**
 * Verify a ticket against the expected lesson, and optionally the expected user.
 *
 * The order matters. The signature is checked before anything in the payload is
 * trusted, so a forged ticket never reaches the expiry or binding checks and
 * cannot be used to probe which lesson ids exist.
 */
export function verifyTicket(
  ticket: string | undefined | null,
  expected: { lessonId: string; userId?: string },
  secret: string,
  now: Date = new Date(),
): TicketVerification {
  if (typeof ticket !== 'string' || ticket.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  const separator = ticket.indexOf('.');
  if (separator <= 0 || separator === ticket.length - 1) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = ticket.slice(0, separator);
  const provided = ticket.slice(separator + 1);

  const expectedSignature = Buffer.from(sign(payload, secret), 'utf8');
  const providedSignature = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws on a length mismatch, and the length of a base64url
  // HMAC-SHA256 is fixed, so an unequal length is already a forgery.
  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims: TicketClaims;
  try {
    const parsed = JSON.parse(fromBase64url(payload).toString('utf8')) as Partial<TicketClaims>;
    if (
      typeof parsed.sub !== 'string' ||
      typeof parsed.lid !== 'string' ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp)
    ) {
      return { ok: false, reason: 'malformed' };
    }
    claims = { sub: parsed.sub, lid: parsed.lid, exp: parsed.exp };
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.exp <= Math.floor(now.getTime() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  if (claims.lid !== expected.lessonId) {
    return { ok: false, reason: 'wrong-lesson' };
  }
  if (expected.userId !== undefined && claims.sub !== expected.userId) {
    return { ok: false, reason: 'wrong-user' };
  }
  return { ok: true, claims };
}
