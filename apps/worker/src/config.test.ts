import { describe, expect, it } from 'vitest';
import { backoffSeconds, workerConfigFromEnv } from './config';

describe('backoffSeconds', () => {
  it('doubles per attempt', () => {
    expect(backoffSeconds(1, 15)).toBe(15);
    expect(backoffSeconds(2, 15)).toBe(30);
    expect(backoffSeconds(3, 15)).toBe(60);
  });

  it('caps, so a retry is never indistinguishable from never', () => {
    // Uncapped doubling reaches days by the tenth attempt, which for a video an
    // instructor is waiting on is the same as giving up without saying so.
    expect(backoffSeconds(20, 15)).toBe(600);
  });

  it('handles a zeroth attempt without going below the base', () => {
    expect(backoffSeconds(0, 15)).toBe(15);
  });
});

describe('workerConfigFromEnv', () => {
  it('has working defaults', () => {
    const config = workerConfigFromEnv({});
    expect(config.pollMs).toBe(2_000);
    expect(config.leaseSeconds).toBe(1_800);
    expect(config.maxAttempts).toBe(3);
    expect(config.id).toMatch(/^worker-/);
  });

  it('treats a blank variable as absent rather than as zero', () => {
    // `Number('')` is 0, which would mean a zero-second lease: every job would
    // be reclaimed the instant it was claimed, and nothing would ever finish.
    const config = workerConfigFromEnv({ JOB_LEASE_SECONDS: '   ', WORKER_POLL_MS: '' });
    expect(config.leaseSeconds).toBe(1_800);
    expect(config.pollMs).toBe(2_000);
  });

  it('honours explicit values', () => {
    const config = workerConfigFromEnv({ WORKER_ID: 'w7', JOB_LEASE_SECONDS: '60' });
    expect(config.id).toBe('w7');
    expect(config.leaseSeconds).toBe(60);
  });
});
