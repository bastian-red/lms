import { z } from 'zod';
import { passwordSchema } from '../auth/password-strength';
import type { StudentQuiz } from '../quiz/grading';

/**
 * The wire contract between apps/web, apps/api and apps/worker.
 *
 * One definition per shape, imported by both sides. The API validates with
 * these through ZodValidationPipe; the web app parses form input with the same
 * schemas, so the two cannot disagree about what a valid request is.
 */

export type Role = 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';
export const ROLES: readonly Role[] = ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const;
export const roleSchema = z.enum(['STUDENT', 'INSTRUCTOR', 'ADMIN']);

// ---------------------------------------------------------------- auth

export const signupSchema = z.object({
  email: z.string().email('Enter a valid email address.').max(320),
  name: z.string().trim().min(1, 'Tell us your name.').max(120),
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(320),
  // Not `passwordSchema`: tightening the policy must not lock out accounts
  // created under the old one. The stored hash is the only authority here.
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

// ---------------------------------------------------------------- catalog

export type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export const courseStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export type LessonKind = 'VIDEO' | 'QUIZ';
export const lessonKindSchema = z.enum(['VIDEO', 'QUIZ']);

export type VideoStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface CourseSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: CourseStatus;
  instructor: { id: string; name: string | null };
  lessonCount: number;
  totalDurationSeconds: number;
  enrolledCount: number;
}

export interface LessonSummary {
  id: string;
  title: string;
  kind: LessonKind;
  position: number;
  /** Media duration in seconds. 0 for a quiz or an unprocessed video. */
  durationSeconds: number;
  /** Playable without enrolling. Exactly one preview lesson per course. */
  isPreview: boolean;
  videoStatus: VideoStatus | null;
}

export interface ModuleSummary {
  id: string;
  title: string;
  position: number;
  lessons: LessonSummary[];
}

export interface CourseDetail extends CourseSummary {
  description: string;
  modules: ModuleSummary[];
  /** Present when the caller is signed in. */
  enrollment: EnrollmentSummary | null;
}

// ---------------------------------------------------------------- enrollment

export type EnrollmentStatus = 'ACTIVE' | 'REVOKED' | 'COMPLETED';

export interface EnrollmentSummary {
  id: string;
  status: EnrollmentStatus;
  enrolledAt: string;
  /** Fraction of the course's published lessons completed, 0-1. */
  progress: number;
  completedLessonIds: string[];
  certificateSerial: string | null;
}

// ---------------------------------------------------------------- playback

export interface LessonPlayback {
  lessonId: string;
  title: string;
  kind: LessonKind;
  durationSeconds: number;
  /** Absolute URL of the master playlist, ticket included. Null for a quiz. */
  manifestUrl: string | null;
  /** Renditions the ladder produced, widest first. */
  renditions: { name: string; height: number; bitrateKbps: number }[];
  /** Seconds already covered by this student. */
  secondsWatched: number;
  completed: boolean;
  quiz: StudentQuiz | null;
  /** Best score so far, or null when never attempted. */
  bestScorePercent: number | null;
  quizPassed: boolean;
}

/**
 * A heartbeat from the player: the ranges watched since the last beat.
 *
 * Bounded at 60 intervals so one request cannot make the server merge an
 * unbounded array. A player producing more than that per beat is broken or
 * hostile, and either way the honest ones never come close.
 */
export const intervalSchema = z
  .object({
    start: z.number().finite().min(0),
    end: z.number().finite().min(0),
  })
  .refine((value) => value.end > value.start, { message: 'end must be after start' });

export const heartbeatSchema = z.object({
  intervals: z.array(intervalSchema).max(60),
});
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

export interface HeartbeatResult {
  secondsWatched: number;
  coverage: number;
  completed: boolean;
  /** True when the server refused part of the report. Surfaced in the UI. */
  clamped: boolean;
}

// ---------------------------------------------------------------- quiz

export const quizAnswerSchema = z.object({
  questionId: z.string().min(1),
  choiceIds: z.array(z.string().min(1)).max(20).optional(),
  text: z.string().max(500).optional(),
});

export const quizSubmissionSchema = z.object({
  answers: z.array(quizAnswerSchema).max(200),
});
export type QuizSubmissionInput = z.infer<typeof quizSubmissionSchema>;

export interface QuizAttemptResult {
  attemptId: string;
  scorePercent: number;
  passed: boolean;
  /** Per-question verdicts. Correct answers are never included. */
  outcomes: { questionId: string; correct: boolean }[];
  bestScorePercent: number;
}

// ---------------------------------------------------------------- certificate

export interface CertificateSummary {
  serial: string;
  issuedAt: string;
  courseTitle: string;
  studentName: string;
  /** Where the PDF can be downloaded. */
  downloadPath: string;
}

/** What /verify/[serial] shows. Deliberately minimal: it is a public page. */
export interface CertificateVerification {
  valid: boolean;
  serial: string;
  courseTitle: string | null;
  studentName: string | null;
  issuedAt: string | null;
}

// ---------------------------------------------------------------- authoring

export const createCourseSchema = z.object({
  title: z.string().trim().min(3).max(160),
  summary: z.string().trim().min(3).max(300),
  description: z.string().trim().max(5_000).default(''),
});
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

export const updateCourseSchema = createCourseSchema.partial().extend({
  status: courseStatusSchema.optional(),
});
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

export const createModuleSchema = z.object({
  title: z.string().trim().min(1).max(160),
});
export type CreateModuleInput = z.infer<typeof createModuleSchema>;

export const createLessonSchema = z.object({
  moduleId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  kind: lessonKindSchema,
  isPreview: z.boolean().default(false),
});
export type CreateLessonInput = z.infer<typeof createLessonSchema>;

export const upsertQuizSchema = z.object({
  title: z.string().trim().min(1).max(160),
  passingScore: z.number().int().min(0).max(100),
  questions: z
    .array(
      z.object({
        kind: z.enum(['SINGLE', 'MULTI', 'TRUE_FALSE', 'SHORT_TEXT']),
        prompt: z.string().trim().min(1).max(1_000),
        points: z.number().int().min(1).max(20).default(1),
        acceptedAnswers: z.array(z.string().max(200)).max(20).default([]),
        choices: z
          .array(z.object({ label: z.string().trim().min(1).max(300), isCorrect: z.boolean() }))
          .max(10)
          .default([]),
      }),
    )
    .min(1)
    .max(100),
});
export type UpsertQuizInput = z.infer<typeof upsertQuizSchema>;

// ---------------------------------------------------------------- admin

export const setRoleSchema = z.object({ role: roleSchema });
export type SetRoleInput = z.infer<typeof setRoleSchema>;

// ---------------------------------------------------------------- health

export interface Health {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: {
    database: boolean;
    redis: boolean;
    /** ffmpeg resolves and runs. Without it nothing can be transcoded. */
    ffmpeg: boolean;
    /** The media root exists and is writable. */
    mediaStorage: boolean;
    /** A transcode worker has checked in recently. */
    worker: boolean;
  };
  version: string;
  timestamp: string;
}
