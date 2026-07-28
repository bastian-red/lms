import { auth } from '../auth';
import { API_BASE_URL } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The API's structured body, when it sent one. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText;
    let body: unknown;
    try {
      body = await response.json();
      const record = body as { message?: unknown };
      if (typeof record.message === 'string') message = record.message;
      // Nest nests a structured error inside `message` when the handler throws
      // an exception with an object payload — the certificate eligibility 409
      // does exactly that.
      else if (record.message && typeof record.message === 'object') {
        body = record.message;
        message = (record.message as { message?: string }).message ?? message;
      }
    } catch {
      // A non-JSON error body is not worth failing over; the status is enough.
    }
    throw new ApiError(response.status, message, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Public server-side call. No auth. */
export async function publicApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  return parse<T>(response);
}

/**
 * Cached public call, for catalogue reads that feed ISR pages.
 *
 * Tagged so publishing a course can invalidate exactly the affected pages with
 * `revalidateTag`, rather than waiting out a fixed window or rebuilding
 * everything.
 */
export async function cachedApiFetch<T>(
  path: string,
  tags: string[],
  revalidateSeconds = 60,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'content-type': 'application/json' },
    next: { tags, revalidate: revalidateSeconds },
  });
  return parse<T>(response);
}

/** Authenticated server-side call as the signed-in user. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await auth();
  if (!session?.user) throw new ApiError(401, 'Not authenticated');
  const { mintServiceToken } = await import('./service-token');
  const token = mintServiceToken(session.user.id, session.user.email, session.user.role);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  return parse<T>(response);
}

/**
 * The same call, but tolerating an anonymous caller.
 *
 * The course page is public and shows more when signed in, so it must work
 * either way rather than 401ing a visitor who is simply not logged in.
 */
export async function optionalApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await auth();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session?.user) {
    const { mintServiceToken } = await import('./service-token');
    headers.authorization = `Bearer ${mintServiceToken(
      session.user.id,
      session.user.email,
      session.user.role,
    )}`;
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  return parse<T>(response);
}

/**
 * Mint a token for the browser.
 *
 * The player is the one place client-side code needs to call the API directly:
 * hls.js issues its own requests and Server Components cannot proxy a video
 * stream. The token is short-lived and is only ever used to fetch the manifest,
 * which then carries a ticket for everything downstream.
 */
export async function browserToken(): Promise<string | null> {
  const session = await auth();
  if (!session?.user) return null;
  const { mintServiceToken } = await import('./service-token');
  return mintServiceToken(session.user.id, session.user.email, session.user.role);
}
