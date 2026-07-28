import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isSecondsWatchedViolation } from '@lms/db';
import {
  applyHeartbeat,
  gradeAttempt,
  parseIntervals,
  toStored,
  toStudentQuiz,
  type GradableQuiz,
  type HeartbeatResult,
  type Interval,
  type LessonPlayback,
  type QuizAttemptResult,
  type QuizSubmissionInput,
} from '@lms/shared';
import { CONFIG, type AppConfig } from '../config/config';
import { MediaAccessService } from '../media/media-access.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What a student does inside a lesson: watch it, and take its quiz.
 *
 * The two properties this file owns:
 *
 *   **Progress reflects watching, not seeking.** The heartbeat's merge runs
 *   inside a transaction that re-reads the stored intervals, so two beats
 *   arriving together cannot each overwrite the other's merge. The clamp itself
 *   is pure and lives in @lms/shared; here it is given the two things it needs
 *   from the database and nothing else: the authoritative duration, and when
 *   this student's previous beat landed.
 *
 *   **The answer key stays on the server.** The quiz is loaded with its answers
 *   because grading needs them, and it is projected through `toStudentQuiz`
 *   before it is ever returned. The projection is an explicit whitelist, and a
 *   unit test deep-scans its output for `isCorrect` and `acceptedAnswers`.
 */
@Injectable()
export class LearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MediaAccessService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Everything the lesson page needs, in one call. */
  async playback(userId: string, lessonId: string): Promise<LessonPlayback> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        kind: true,
        videoAsset: { select: { durationSeconds: true, renditions: true } },
        quiz: { select: quizSelect },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    if (lesson.kind === 'VIDEO') {
      // Authorisation for a video lesson is exactly the playback check, so it
      // is not duplicated here: assertCanWatch throws 403/404 and its result is
      // what the manifest URL is built from.
      await this.access.assertCanWatch(userId, lessonId);
    } else {
      await this.assertCanAccessLesson(userId, lessonId);
    }

    const progress = await this.prisma.lessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
      select: { secondsWatched: true, completed: true },
    });

    const attempts =
      lesson.quiz === null
        ? []
        : await this.prisma.quizAttempt.findMany({
            where: { quizId: lesson.quiz.id, userId },
            select: { scorePercent: true, passed: true },
          });

    return {
      lessonId: lesson.id,
      title: lesson.title,
      kind: lesson.kind,
      durationSeconds: lesson.videoAsset?.durationSeconds ?? 0,
      manifestUrl:
        lesson.kind === 'VIDEO'
          ? `${this.config.apiBaseUrl}/lessons/${encodeURIComponent(lesson.id)}/manifest.m3u8`
          : null,
      renditions: parseRenditions(lesson.videoAsset?.renditions),
      secondsWatched: progress?.secondsWatched ?? 0,
      completed: progress?.completed ?? false,
      quiz: lesson.quiz ? toStudentQuiz(toGradableQuiz(lesson.quiz)) : null,
      bestScorePercent:
        attempts.length > 0 ? Math.max(...attempts.map((a) => a.scorePercent)) : null,
      quizPassed: attempts.some((attempt) => attempt.passed),
    };
  }

  /**
   * Record watched intervals.
   *
   * Runs in a transaction and re-reads the progress row inside it. Two beats
   * landing at once would otherwise both read the same "before" state, merge
   * their own interval into it, and the second write would discard the first's
   * coverage. A player with a flaky connection retries, so this is a case that
   * happens rather than a theoretical one.
   */
  async heartbeat(
    userId: string,
    lessonId: string,
    reported: Interval[],
  ): Promise<HeartbeatResult> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, kind: true, videoAsset: { select: { durationSeconds: true } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.kind !== 'VIDEO') {
      throw new ForbiddenException('Only video lessons record watch progress');
    }
    // Authorisation is the playback check: a student who cannot watch the
    // lesson must not be able to accrue progress on it either, which is
    // otherwise a way to complete a course you were never enrolled in.
    await this.access.assertCanWatch(userId, lessonId);

    const duration = lesson.videoAsset?.durationSeconds ?? 0;
    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.lessonProgress.findUnique({
          where: { userId_lessonId: { userId, lessonId } },
          select: { watchedIntervals: true, lastBeatAt: true, completedAt: true },
        });

        const result = applyHeartbeat({
          stored: parseIntervals(existing?.watchedIntervals),
          reported,
          duration,
          // The wall-clock budget. Null on the first beat, because there is no
          // previous one to measure from; every later beat is bounded by how
          // much real time has passed, which is what makes a fabricated
          // full-length interval unprofitable.
          elapsedSinceLastBeat: existing?.lastBeatAt
            ? (now.getTime() - existing.lastBeatAt.getTime()) / 1000
            : null,
          threshold: this.config.completionThreshold,
        });

        // Stamped the first time the lesson completes and never moved after
        // that. Re-stamping on every later beat would make "when did you finish
        // this" mean "when did you last open it", and clearing it on a
        // threshold change would erase the fact that they finished at all.
        const completedAt = result.completed ? (existing?.completedAt ?? now) : null;

        const data = {
          watchedIntervals: toStored(result.intervals),
          secondsWatched: result.secondsWatched,
          completed: result.completed,
          completedAt,
          lastBeatAt: now,
        };

        await tx.lessonProgress.upsert({
          where: { userId_lessonId: { userId, lessonId } },
          update: data,
          create: { userId, lessonId, ...data },
        });

        return {
          secondsWatched: result.secondsWatched,
          coverage: result.coverage,
          completed: result.completed,
          clamped: result.rejectedSeconds > 0,
        };
      });
    } catch (error) {
      // The database trigger refusing the row means the pure clamp let
      // something through that it should not have. That is a bug in the engine,
      // not a client error, so it is surfaced loudly rather than swallowed.
      if (isSecondsWatchedViolation(error)) {
        throw new ForbiddenException('Reported progress exceeds the length of this lesson');
      }
      throw error;
    }
  }

  /**
   * Grade a quiz submission.
   *
   * Attempts are unlimited by design: this is a learning platform, not an exam
   * board, and the certificate rule is "passed", not "passed first time". The
   * best score is what the student and the certificate check see.
   */
  async submitQuiz(
    userId: string,
    lessonId: string,
    submission: QuizSubmissionInput,
  ): Promise<QuizAttemptResult> {
    await this.assertCanAccessLesson(userId, lessonId);

    const quizRow = await this.prisma.quiz.findUnique({
      where: { lessonId },
      select: quizSelect,
    });
    if (!quizRow) throw new NotFoundException('This lesson has no quiz');

    const quiz = toGradableQuiz(quizRow);
    const result = gradeAttempt(quiz, submission.answers);

    const attempt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.quizAttempt.create({
        data: {
          quizId: quiz.id,
          userId,
          scorePercent: result.scorePercent,
          passed: result.passed,
          answers: submission.answers,
        },
        select: { id: true },
      });

      // A passed quiz completes its lesson. Without this a quiz lesson could
      // never be finished, and the certificate rule — every lesson complete —
      // would be unsatisfiable for any course containing one.
      if (result.passed) {
        await tx.lessonProgress.upsert({
          where: { userId_lessonId: { userId, lessonId } },
          update: { completed: true, completedAt: new Date() },
          create: { userId, lessonId, completed: true, completedAt: new Date() },
        });
      }
      return created;
    });

    const best = await this.prisma.quizAttempt.aggregate({
      where: { quizId: quiz.id, userId },
      _max: { scorePercent: true },
    });

    return {
      attemptId: attempt.id,
      scorePercent: result.scorePercent,
      passed: result.passed,
      // Which questions were right, never what the right answer was. Telling a
      // student the answer on a quiz with unlimited attempts makes the quiz
      // meaningless.
      outcomes: result.outcomes.map((outcome) => ({
        questionId: outcome.questionId,
        correct: outcome.correct,
      })),
      bestScorePercent: best._max.scorePercent ?? result.scorePercent,
    };
  }

  /**
   * Enrollment check for non-video lessons.
   *
   * Video lessons go through `MediaAccessService.assertCanWatch`, which is the
   * same rule plus the asset checks. Keeping one implementation of each and
   * calling the right one beats a third copy that can drift.
   */
  private async assertCanAccessLesson(userId: string, lessonId: string): Promise<void> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        published: true,
        isPreview: true,
        module: {
          select: {
            course: {
              select: {
                status: true,
                instructorId: true,
                enrollments: { where: { userId }, select: { status: true }, take: 1 },
              },
            },
          },
        },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    const course = lesson.module.course;
    if (course.instructorId === userId) return;
    if (lesson.isPreview && lesson.published && course.status === 'PUBLISHED') return;

    const status = course.enrollments[0]?.status;
    if (status !== 'ACTIVE' && status !== 'COMPLETED') {
      throw new ForbiddenException('Not enrolled in this course');
    }
    if (!lesson.published) throw new ForbiddenException('Lesson is not published');
    if (course.status !== 'PUBLISHED') throw new ForbiddenException('Course is not published');
  }
}

/** Server-side quiz shape, answers included. Never returned as-is. */
const quizSelect = {
  id: true,
  title: true,
  passingScore: true,
  questions: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      kind: true,
      prompt: true,
      points: true,
      acceptedAnswers: true,
      choices: {
        orderBy: { position: 'asc' },
        select: { id: true, label: true, isCorrect: true },
      },
    },
  },
} as const;

type QuizRow = {
  id: string;
  title: string;
  passingScore: number;
  questions: {
    id: string;
    kind: string;
    prompt: string;
    points: number;
    acceptedAnswers: string[];
    choices: { id: string; label: string; isCorrect: boolean }[];
  }[];
};

function toGradableQuiz(row: QuizRow): GradableQuiz {
  return {
    id: row.id,
    title: row.title,
    passingScore: row.passingScore,
    questions: row.questions.map((question) => ({
      id: question.id,
      kind: question.kind as GradableQuiz['questions'][number]['kind'],
      prompt: question.prompt,
      points: question.points,
      acceptedAnswers: question.acceptedAnswers,
      choices: question.choices,
    })),
  };
}

/**
 * Read the renditions out of the JSON column defensively.
 *
 * The column is written by the worker, so a row from an older version of the
 * pipeline is a real possibility. A malformed value costs the quality selector
 * in the UI, not the lesson.
 */
export function parseRenditions(value: unknown): LessonPlayback['renditions'] {
  if (!Array.isArray(value)) return [];
  const out: LessonPlayback['renditions'] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, height, bitrateKbps } = entry as Record<string, unknown>;
    if (typeof name === 'string' && typeof height === 'number' && typeof bitrateKbps === 'number') {
      out.push({ name, height, bitrateKbps });
    }
  }
  return out.sort((a, b) => b.height - a.height);
}
