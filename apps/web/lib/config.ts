/** Server-side API base URL. Inside a container this is the service name. */
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * Browser-facing API base URL, baked at build time by infra/Dockerfile.web.
 *
 * The player needs this: hls.js fetches playlists, segments and the key
 * directly from the API, so the browser must be able to reach it by a URL that
 * is meaningful outside the compose network.
 */
export const PUBLIC_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000';
