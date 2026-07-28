import { describe, expect, it } from 'vitest';
import { loadConfig, rateLimitsFromEnv } from './config';

const BASE = { AUTH_SECRET: 'a'.repeat(32) };

describe('loadConfig', () => {
  it('refuses to boot without a secret', () => {
    // The same secret verifies service tokens and signs playback tickets, so a
    // missing one is a total auth failure plus forgeable tickets. It must
    // surface at boot, not on the first request.
    expect(() => loadConfig({})).toThrow(/AUTH_SECRET/);
  });

  it('refuses a short secret', () => {
    expect(() => loadConfig({ AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('has working defaults for everything else', () => {
    const config = loadConfig(BASE);
    expect(config.port).toBe(4000);
    expect(config.ticketTtlMinutes).toBe(120);
    expect(config.completionThreshold).toBe(0.9);
    expect(config.maxUploadBytes).toBe(512 * 1024 * 1024);
  });

  it('treats a blank numeric variable as absent', () => {
    // `Number('')` is 0: a blank MAX_UPLOAD_BYTES would refuse every upload and
    // a blank ticket TTL would issue tickets that are already expired.
    const config = loadConfig({ ...BASE, MAX_UPLOAD_BYTES: '  ', MEDIA_TICKET_TTL_MINUTES: '' });
    expect(config.maxUploadBytes).toBe(512 * 1024 * 1024);
    expect(config.ticketTtlMinutes).toBe(120);
  });

  it('rejects a completion threshold outside (0, 1]', () => {
    expect(loadConfig({ ...BASE, COMPLETION_THRESHOLD: '1.5' }).completionThreshold).toBe(0.9);
    expect(loadConfig({ ...BASE, COMPLETION_THRESHOLD: '0' }).completionThreshold).toBe(0.9);
    expect(loadConfig({ ...BASE, COMPLETION_THRESHOLD: '0.75' }).completionThreshold).toBe(0.75);
  });

  it('gives media routes a much larger budget than everything else', () => {
    // A ten-minute lesson is ~150 segment requests. Under the global budget,
    // honest playback would be rate limited.
    const limits = rateLimitsFromEnv({});
    expect(limits.media).toBeGreaterThan(limits.global * 10);
    expect(limits.auth).toBeLessThan(limits.global);
  });
});
