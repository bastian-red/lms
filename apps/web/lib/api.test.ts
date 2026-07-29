import { afterEach, describe, expect, it, vi } from 'vitest';

// `lib/api.ts` imports `auth` at module scope for the authenticated helpers,
// which pulls next-auth and, through it, `next/server` — unresolvable outside
// the Next runtime. The helpers under test here are the anonymous ones and
// never call it, so the module is stubbed rather than loaded.
vi.mock('../auth', () => ({
  auth: vi.fn().mockResolvedValue(null),
  signOut: vi.fn(),
}));

// Values come from a dynamic import so the mock above is registered first. The
// type comes from a static `import type`, which is erased at compile time and
// so does not reintroduce the runtime dependency the mock exists to avoid.
import type { ApiError as ApiErrorType } from './api';

const { ApiError, cachedApiFetch, publicApiFetch } = await import('./api');

/**
 * `lib/api.ts` is the only thing between every server component and the API,
 * and two of its behaviours are load-bearing in ways that are easy to break
 * silently.
 *
 * 1. The tag and revalidate window it hands to `fetch`. Every route in this app
 *    is dynamic — `Nav` reads the session in the root layout, so `next build`
 *    marks even `/_not-found` as `ƒ`. The page-level cache is therefore not
 *    available and the fetch-level Data Cache is the only thing stopping the
 *    catalogue from querying the API once per visitor. Drop the `next` option
 *    and nothing fails, nothing logs, the API just quietly takes every hit.
 *
 * 2. Nest's nested error body. When a handler throws with an object payload the
 *    real message ends up at `body.message.message`, not `body.message`. The
 *    certificate 409 does exactly that, and getting it wrong shows the user
 *    "Conflict" instead of the lessons they still owe.
 */
function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({}),
    ...response,
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cachedApiFetch', () => {
  it('tags the fetch so revalidateTag can invalidate exactly it', async () => {
    const spy = mockFetch({ json: async () => [{ id: 'c1' }] });

    await cachedApiFetch('/courses', ['courses']);

    const init = spy.mock.calls[0][1] as RequestInit & {
      next?: { tags?: string[]; revalidate?: number };
    };
    expect(init.next?.tags).toEqual(['courses']);
  });

  it('caches for 60s by default, so the catalogue does not hit the API per visitor', async () => {
    const spy = mockFetch({ json: async () => [] });

    await cachedApiFetch('/courses', ['courses']);

    const init = spy.mock.calls[0][1] as RequestInit & { next?: { revalidate?: number } };
    expect(init.next?.revalidate).toBe(60);
  });

  it('honours an explicit window', async () => {
    const spy = mockFetch({ json: async () => [] });

    await cachedApiFetch('/courses', ['courses'], 5);

    const init = spy.mock.calls[0][1] as RequestInit & { next?: { revalidate?: number } };
    expect(init.next?.revalidate).toBe(5);
  });

  it('never sends no-store, which would defeat the cache entirely', async () => {
    const spy = mockFetch({ json: async () => [] });

    await cachedApiFetch('/courses', ['courses']);

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBeUndefined();
  });
});

describe('publicApiFetch', () => {
  it('opts out of the cache, because it is used for per-request reads', async () => {
    const spy = mockFetch({ json: async () => ({ ok: true }) });

    await publicApiFetch('/health');

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe('no-store');
  });
});

describe('error parsing', () => {
  it('lifts a flat message off the body', async () => {
    mockFetch({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'No such course' }),
    });

    await expect(publicApiFetch('/courses/nope')).rejects.toMatchObject({
      status: 404,
      message: 'No such course',
    });
  });

  it('unwraps Nest’s nested object payload, so a 409 names what is outstanding', async () => {
    mockFetch({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        message: {
          message: 'Course not finished',
          outstanding: [{ id: 'l1', title: 'Designing a bitrate ladder' }],
        },
      }),
    });

    const error = await publicApiFetch('/certificates').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiErrorType).status).toBe(409);
    expect((error as ApiErrorType).message).toBe('Course not finished');
    // The outstanding list has to survive: it is what the UI renders.
    expect((error as ApiErrorType).body).toMatchObject({
      outstanding: [{ title: 'Designing a bitrate ladder' }],
    });
  });

  it('falls back to the status text when the body is not JSON', async () => {
    mockFetch({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(publicApiFetch('/courses')).rejects.toMatchObject({
      status: 502,
      message: 'Bad Gateway',
    });
  });

  it('returns undefined on 204 rather than trying to parse an empty body', async () => {
    mockFetch({
      status: 204,
      json: async () => {
        throw new Error('204 has no body to parse');
      },
    });

    await expect(publicApiFetch('/enrollments/e1')).resolves.toBeUndefined();
  });
});
