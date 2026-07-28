import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueTicket, verifyTicket } from './ticket';

const SECRET = 'unit-test-secret-at-least-32-characters';
const OTHER_SECRET = 'a-different-secret-at-least-32-characters';
const USER = 'user_alice';
const LESSON = 'lesson_intro';

describe('issueTicket / verifyTicket', () => {
  it('round-trips a valid ticket', () => {
    const ticket = issueTicket(USER, LESSON, SECRET);
    const result = verifyTicket(ticket, { lessonId: LESSON, userId: USER }, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe(USER);
      expect(result.claims.lid).toBe(LESSON);
    }
  });

  it('rejects a ticket signed with another secret', () => {
    const ticket = issueTicket(USER, LESSON, OTHER_SECRET);
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a tampered payload', () => {
    // The attack this is really guarding: take your own ticket, swap the lesson
    // id, keep the signature.
    const ticket = issueTicket(USER, LESSON, SECRET);
    const [, signature] = ticket.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: USER, lid: 'lesson_paid_course', exp: 9_999_999_999 }),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(verifyTicket(`${forgedPayload}.${signature}`, { lessonId: LESSON }, SECRET)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a ticket for another lesson', () => {
    // A genuine ticket for a free lesson must not open a paid one.
    const ticket = issueTicket(USER, 'lesson_free_preview', SECRET);
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET)).toEqual({
      ok: false,
      reason: 'wrong-lesson',
    });
  });

  it('rejects a ticket minted for another user', () => {
    // A shared URL is worthless to the person it was shared with.
    const ticket = issueTicket('user_bob', LESSON, SECRET);
    expect(verifyTicket(ticket, { lessonId: LESSON, userId: USER }, SECRET)).toEqual({
      ok: false,
      reason: 'wrong-user',
    });
  });

  it('rejects an expired ticket', () => {
    const issuedAt = new Date('2026-07-28T10:00:00Z');
    const ticket = issueTicket(USER, LESSON, SECRET, 5, issuedAt);
    const later = new Date('2026-07-28T10:05:01Z');
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET, later)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('accepts a ticket one second before expiry', () => {
    const issuedAt = new Date('2026-07-28T10:00:00Z');
    const ticket = issueTicket(USER, LESSON, SECRET, 5, issuedAt);
    const justBefore = new Date('2026-07-28T10:04:59Z');
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET, justBefore).ok).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of [undefined, null, '', 'no-separator', '.only-signature', 'payload.']) {
      expect(verifyTicket(bad, { lessonId: LESSON }, SECRET).ok).toBe(false);
    }
  });

  it('rejects a well-signed payload that is not a ticket', () => {
    // Signature valid, claims nonsense. Must fail on shape rather than crash on
    // a missing field.
    const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const signature = createHmac('sha256', SECRET)
      .update(payload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyTicket(`${payload}.${signature}`, { lessonId: LESSON }, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('checks the signature before the payload, so a forgery cannot probe ids', () => {
    // An expired ticket for the wrong lesson, re-signed with the wrong secret,
    // must report the signature failure and nothing about the claims.
    const ticket = issueTicket(USER, 'some-other-lesson', OTHER_SECRET, 1, new Date(0));
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET).ok).toBe(false);
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('produces URL-safe output', () => {
    // The ticket rides in a query string that hls.js copies verbatim; a raw
    // base64 '+' or '/' would be re-encoded somewhere along the way and break
    // the compare.
    for (let n = 0; n < 50; n += 1) {
      const ticket = issueTicket(`user_${n}`, `lesson_${n}`, SECRET);
      expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  });

  it('does not accept a ticket whose user check is skipped by omission', () => {
    // Omitting `userId` is a deliberate mode (the manifest route has already
    // matched the user), so it must still enforce the lesson binding.
    const ticket = issueTicket('user_bob', 'lesson_other', SECRET);
    expect(verifyTicket(ticket, { lessonId: LESSON }, SECRET).ok).toBe(false);
  });
});
