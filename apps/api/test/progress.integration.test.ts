import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  loadFixture,
  prisma,
  resetStudent,
  serviceToken,
  type SeedFixture,
} from './helpers';

/**
 * Property 3: progress cannot be faked by seeking.
 *
 * The unit tests cover the arithmetic. These cover what the arithmetic is worth
 * once a real client is posting to a real endpoint against a real database — in
 * particular that the wall-clock budget is measured from a persisted timestamp,
 * not from anything the client sends.
 */
describe('watch progress', () => {
  let fixture: SeedFixture;
  let token: string;

  beforeAll(async () => {
    fixture = await loadFixture();
    token = serviceToken(fixture.studentId, 'ada@lms.local', 'STUDENT');
  });

  beforeEach(async () => {
    await resetStudent(fixture);
  });

  afterAll(async () => {
    await resetStudent(fixture);
    await prisma.$disconnect();
  });

  const beat = (intervals: { start: number; end: number }[]) =>
    api<{ secondsWatched: number; coverage: number; completed: boolean; clamped: boolean }>(
      `/lessons/${fixture.videoLessonId}/progress`,
      { method: 'POST', token, body: JSON.stringify({ intervals }) },
    );

  it('credits seeking to the end with only what was watched there', async () => {
    // The headline case. Drag to the last two seconds, let it play, claim the
    // lesson. Tracking currentTime would call this 100%.
    const duration = fixture.durationSeconds;
    const response = await beat([{ start: duration - 2, end: duration }]);

    expect(response.status).toBe(201);
    expect(response.body.secondsWatched).toBeLessThan(3);
    expect(response.body.completed).toBe(false);
  });

  it('refuses a fabricated full-length interval on a later beat', async () => {
    // The first beat is trusted up to the media duration, because there is no
    // previous beat to measure elapsed time from. Every beat after it is
    // bounded by the clock.
    await beat([{ start: 0, end: 1 }]);
    const response = await beat([{ start: 0, end: fixture.durationSeconds }]);

    expect(response.body.clamped).toBe(true);
    expect(response.body.secondsWatched).toBeLessThan(fixture.durationSeconds);
  });

  it('clamps an interval that runs past the end of the media', async () => {
    const response = await beat([{ start: 0, end: 999_999 }]);
    expect(response.body.secondsWatched).toBeLessThanOrEqual(fixture.durationSeconds + 1);
  });

  it('does not double count a replayed range', async () => {
    // A reconnecting player resends its buffer. Coverage is a union, so this
    // adds nothing and must not consume the wall-clock budget either.
    const first = await beat([{ start: 0, end: 5 }]);
    const second = await beat([{ start: 0, end: 5 }]);
    expect(second.body.secondsWatched).toBeCloseTo(first.body.secondsWatched, 1);
    expect(second.body.clamped).toBe(false);
  });

  it('rejects a malformed interval with a 400 rather than storing it', async () => {
    const response = await beat([{ start: 10, end: 5 }]);
    expect(response.status).toBe(400);
  });

  it('caps the number of intervals one beat may carry', async () => {
    // Unbounded, one request could make the server merge an arbitrarily large
    // array. An honest player never comes close to sixty.
    const many = Array.from({ length: 200 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
    }));
    const response = await beat(many);
    expect(response.status).toBe(400);
  });

  it('refuses progress on a lesson the student cannot watch', async () => {
    // Otherwise accruing progress is a way to complete a course you were never
    // enrolled in.
    await prisma.enrollment.update({
      where: { userId_courseId: { userId: fixture.studentId, courseId: fixture.courseId } },
      data: { status: 'REVOKED' },
    });
    const response = await beat([{ start: 0, end: 5 }]);
    expect(response.status).toBe(403);
  });

  it('refuses progress on a quiz lesson', async () => {
    const response = await api(`/lessons/${fixture.quizLessonId}/progress`, {
      method: 'POST',
      token,
      body: JSON.stringify({ intervals: [{ start: 0, end: 5 }] }),
    });
    expect(response.status).toBe(403);
  });

  it('persists coverage across beats and eventually completes', async () => {
    // Honest playback, sped up: each beat covers the ground the clock allows.
    // The budget floor (15s) is what makes this finish in a handful of requests
    // instead of in real time.
    const duration = fixture.durationSeconds;
    let last = await beat([{ start: 0, end: Math.min(15, duration) }]);
    let covered = 15;
    while (!last.body.completed && covered < duration + 30) {
      last = await beat([{ start: covered, end: Math.min(covered + 14, duration) }]);
      covered += 14;
    }

    expect(last.body.completed).toBe(true);
    expect(last.body.coverage).toBeGreaterThanOrEqual(0.9);

    const row = await prisma.lessonProgress.findUniqueOrThrow({
      where: { userId_lessonId: { userId: fixture.studentId, lessonId: fixture.videoLessonId } },
    });
    expect(row.completed).toBe(true);
    expect(row.completedAt).not.toBeNull();
    // The database trigger is the last line of defence, and it holds.
    expect(row.secondsWatched).toBeLessThanOrEqual(duration + 1);
  });

  it('the database refuses a row claiming more than the media length', async () => {
    // Written directly, bypassing the service, to prove the trigger is real and
    // not merely mirroring what the application already refuses.
    await expect(
      prisma.lessonProgress.create({
        data: {
          userId: fixture.studentId,
          lessonId: fixture.videoLessonId,
          secondsWatched: fixture.durationSeconds + 500,
        },
      }),
    ).rejects.toThrow();
  });
});
