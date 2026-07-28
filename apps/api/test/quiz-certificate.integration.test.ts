import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QuizAttemptResult, StudentQuiz } from '@lms/shared';
import {
  api,
  loadFixture,
  prisma,
  resetStudent,
  serviceToken,
  type SeedFixture,
} from './helpers';

/** Every string value anywhere in a JSON payload. */
function stringValues(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) stringValues(entry, into);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) stringValues(entry, into);
  }
  return into;
}

/**
 * Properties 4 and 5.
 *
 *   4. Answer keys never leave the server.
 *   5. A certificate means the course was actually finished, and issuing is
 *      idempotent under concurrency.
 */
describe('quizzes and certificates', () => {
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

  describe('property 4: the answer key stays on the server', () => {
    it('does not send isCorrect or acceptedAnswers to a student', async () => {
      const response = await api<{ quiz: StudentQuiz | null }>(
        `/lessons/${fixture.quizLessonId}/playback`,
        { token },
      );
      expect(response.status).toBe(200);
      expect(response.body.quiz).not.toBeNull();
      // Scanned as raw text, so a leak nested anywhere in the payload is caught.
      expect(response.text).not.toContain('isCorrect');
      expect(response.text).not.toContain('acceptedAnswers');
    });

    it('does not send the correct free-text answer', async () => {
      const response = await api(`/lessons/${fixture.freeTextQuizLessonId}/playback`, { token });
      const question = await prisma.question.findFirstOrThrow({
        where: { kind: 'SHORT_TEXT', quiz: { lessonId: fixture.freeTextQuizLessonId } },
      });
      expect(question.acceptedAnswers.length).toBeGreaterThan(0);

      // Compared against the payload's string *values*, not against its raw
      // text. A short answer like "47" occurs by coincidence inside a cuid, and
      // a substring check would fail on that rather than on a leak — a test
      // that cries wolf gets deleted, and then the real leak ships.
      const values = new Set(stringValues(JSON.parse(response.text)));
      for (const accepted of question.acceptedAnswers) {
        expect(values.has(accepted)).toBe(false);
        expect(values.has(accepted.toLowerCase())).toBe(false);
      }
    });

    it('grades without telling the student which answer was right', async () => {
      const playback = await api<{ quiz: StudentQuiz }>(
        `/lessons/${fixture.quizLessonId}/playback`,
        { token },
      );
      const wrong = playback.body.quiz.questions.map((question) => ({
        questionId: question.id,
        // Deliberately wrong: first choice for every question, empty text.
        ...(question.kind === 'SHORT_TEXT'
          ? { text: 'definitely not the answer' }
          : { choiceIds: question.choices[0] ? [question.choices[0].id] : [] }),
      }));

      const result = await api<QuizAttemptResult>(`/lessons/${fixture.quizLessonId}/quiz`, {
        method: 'POST',
        token,
        body: JSON.stringify({ answers: wrong }),
      });

      expect(result.status).toBe(201);
      expect(result.body.outcomes.length).toBeGreaterThan(0);
      // Per-question verdicts, and nothing else. On a quiz with unlimited
      // attempts, revealing the answer makes the quiz a reading exercise.
      for (const outcome of result.body.outcomes) {
        expect(Object.keys(outcome).sort()).toEqual(['correct', 'questionId']);
      }
    });
  });

  describe('property 5: a certificate means the course was finished', () => {
    /** Answer every seeded quiz correctly, using the server-side key. */
    async function passEveryQuiz(): Promise<void> {
      const quizzes = await prisma.quiz.findMany({
        where: { lesson: { module: { courseId: fixture.courseId } } },
        include: { questions: { include: { choices: true } } },
      });

      for (const quiz of quizzes) {
        const answers = quiz.questions.map((question) =>
          question.kind === 'SHORT_TEXT'
            ? { questionId: question.id, text: question.acceptedAnswers[0] ?? '' }
            : {
                questionId: question.id,
                choiceIds: question.choices.filter((c) => c.isCorrect).map((c) => c.id),
              },
        );
        const response = await api<QuizAttemptResult>(`/lessons/${quiz.lessonId}/quiz`, {
          method: 'POST',
          token,
          body: JSON.stringify({ answers }),
        });
        expect(response.body.passed).toBe(true);
      }
    }

    /** Mark every video lesson watched, through the database. */
    async function completeEveryVideo(): Promise<void> {
      const lessons = await prisma.lesson.findMany({
        where: { kind: 'VIDEO', published: true, module: { courseId: fixture.courseId } },
        include: { videoAsset: true },
      });
      for (const lesson of lessons) {
        await prisma.lessonProgress.upsert({
          where: { userId_lessonId: { userId: fixture.studentId, lessonId: lesson.id } },
          update: { completed: true, completedAt: new Date() },
          create: {
            userId: fixture.studentId,
            lessonId: lesson.id,
            completed: true,
            completedAt: new Date(),
            secondsWatched: lesson.videoAsset?.durationSeconds ?? 0,
          },
        });
      }
    }

    it('refuses with 409 and names what is outstanding', async () => {
      await passEveryQuiz();
      // Everything except the videos.
      const response = await api<{ message: string; outstanding: string[] }>(
        `/courses/${fixture.courseId}/certificate`,
        { method: 'POST', token },
      );

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/not complete/i);
      // The list is the point: "not eligible" with no reason is a support
      // ticket, while two lesson titles is a student going back to finish them.
      expect(response.body.outstanding.length).toBeGreaterThan(0);
    });

    it('refuses when a quiz was never passed, even if the lesson row says complete', async () => {
      // A progress row alone must not be enough for a quiz lesson: a bug that
      // sets the flag would otherwise hand out certificates for quizzes nobody
      // took.
      await completeEveryVideo();
      await prisma.lessonProgress.upsert({
        where: { userId_lessonId: { userId: fixture.studentId, lessonId: fixture.quizLessonId } },
        update: { completed: true },
        create: { userId: fixture.studentId, lessonId: fixture.quizLessonId, completed: true },
      });

      const response = await api(`/courses/${fixture.courseId}/certificate`, {
        method: 'POST',
        token,
      });
      expect(response.status).toBe(409);
    });

    it('issues exactly one certificate once everything is done', async () => {
      await completeEveryVideo();
      await passEveryQuiz();

      const response = await api<{ serial: string; downloadPath: string }>(
        `/courses/${fixture.courseId}/certificate`,
        { method: 'POST', token },
      );
      expect(response.status).toBe(201);
      expect(response.body.serial).toMatch(/^LMS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      const count = await prisma.certificate.count({
        where: { enrollment: { userId: fixture.studentId, courseId: fixture.courseId } },
      });
      expect(count).toBe(1);

      // The enrollment moves to COMPLETED in the same transaction.
      const enrollment = await prisma.enrollment.findUniqueOrThrow({
        where: { userId_courseId: { userId: fixture.studentId, courseId: fixture.courseId } },
      });
      expect(enrollment.status).toBe('COMPLETED');
    });

    it('is idempotent under concurrency: ten simultaneous requests, one serial', async () => {
      // The unique index on enrollmentId is the arbiter. A read-then-write
      // eligibility check loses this race by construction.
      await completeEveryVideo();
      await passEveryQuiz();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          api<{ serial: string }>(`/courses/${fixture.courseId}/certificate`, {
            method: 'POST',
            token,
          }),
        ),
      );

      const serials = new Set(responses.map((response) => response.body.serial));
      expect(serials.size).toBe(1);
      expect(
        await prisma.certificate.count({
          where: { enrollment: { userId: fixture.studentId, courseId: fixture.courseId } },
        }),
      ).toBe(1);
    });

    it('produces a downloadable PDF', async () => {
      await completeEveryVideo();
      await passEveryQuiz();
      const issued = await api<{ serial: string }>(`/courses/${fixture.courseId}/certificate`, {
        method: 'POST',
        token,
      });

      const pdf = await fetch(
        `${process.env.API_BASE_URL ?? 'http://localhost:4000'}/certificates/${issued.body.serial}/pdf`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toContain('application/pdf');
      const bytes = Buffer.from(await pdf.arrayBuffer());
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('verifies publicly by serial, with no auth', async () => {
      await completeEveryVideo();
      await passEveryQuiz();
      const issued = await api<{ serial: string }>(`/courses/${fixture.courseId}/certificate`, {
        method: 'POST',
        token,
      });

      const check = await api<{ valid: boolean; studentName: string }>(
        `/verify/${issued.body.serial}`,
      );
      expect(check.status).toBe(200);
      expect(check.body.valid).toBe(true);
      expect(check.body.studentName).toBe('Ada Lovelace');
    });

    it('answers a bogus serial without leaking whether it exists', async () => {
      // A 404 for a miss and a 200 for a hit turns the endpoint into an oracle
      // for guessing serials.
      const check = await api<{ valid: boolean }>('/verify/LMS-2222-3333-4444');
      expect(check.status).toBe(200);
      expect(check.body.valid).toBe(false);
    });

    it('keeps a certificate valid after the enrollment is revoked', async () => {
      // Revoking future access is a different decision from retracting a past
      // achievement.
      await completeEveryVideo();
      await passEveryQuiz();
      const issued = await api<{ serial: string }>(`/courses/${fixture.courseId}/certificate`, {
        method: 'POST',
        token,
      });

      await prisma.enrollment.update({
        where: { userId_courseId: { userId: fixture.studentId, courseId: fixture.courseId } },
        data: { status: 'REVOKED' },
      });

      const check = await api<{ valid: boolean }>(`/verify/${issued.body.serial}`);
      expect(check.body.valid).toBe(true);
    });
  });
});
