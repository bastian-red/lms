import { PrismaClient } from '@lms/db';
import jwt from 'jsonwebtoken';

/**
 * Shared plumbing for the integration lane.
 *
 * These tests talk to a real API over HTTP, a real Postgres and a real ffmpeg.
 * That is the point: the properties they prove (segments are encrypted,
 * revocation is immediate, progress cannot be faked) are properties of the whole
 * stack, and a mocked version of any layer would prove nothing about the thing
 * that ships.
 */

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
export const AUTH_SECRET = process.env.AUTH_SECRET ?? 'ci-secret-at-least-32-characters-long';

export const prisma = new PrismaClient();

export type Role = 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';

/** Mint the service token the API's AuthGuard verifies. */
export function serviceToken(userId: string, email = 'test@lms.local', role: Role = 'STUDENT'): string {
  return jwt.sign({ sub: userId, email, role }, AUTH_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

/** Call the API, returning the status and the parsed body without throwing. */
export async function api<T = unknown>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<ApiResponse<T>> {
  const { token, ...rest } = init;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: response.status, body, headers: response.headers, text };
}

/** Raw bytes, for segment and key fetches. */
export async function apiBytes(
  path: string,
): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, headers: response.headers };
}

export interface SeedFixture {
  studentId: string;
  instructorId: string;
  courseId: string;
  /** Published, non-preview video lesson with a READY asset. */
  videoLessonId: string;
  /** The free preview lesson. */
  previewLessonId: string;
  quizLessonId: string;
  /** The quiz lesson containing a SHORT_TEXT question, for the leak test. */
  freeTextQuizLessonId: string;
  assetOutputDir: string;
  durationSeconds: number;
}

/**
 * Read the fixture the seed created.
 *
 * The seed is the fixture, deliberately: the integration suite exercises the
 * same course a developer sees, so a seed that drifts from reality breaks the
 * tests rather than quietly making them meaningless.
 */
export async function loadFixture(): Promise<SeedFixture> {
  const student = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@lms.local' } });
  const instructor = await prisma.user.findUniqueOrThrow({ where: { email: 'grace@lms.local' } });
  const course = await prisma.course.findUniqueOrThrow({
    where: { slug: 'adaptive-video-streaming' },
  });

  const lessons = await prisma.lesson.findMany({
    where: { module: { courseId: course.id } },
    orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
    include: { videoAsset: true },
  });

  const video = lessons.find(
    (lesson) => lesson.kind === 'VIDEO' && !lesson.isPreview && lesson.videoAsset?.status === 'READY',
  );
  const preview = lessons.find((lesson) => lesson.isPreview);
  const quiz = lessons.find((lesson) => lesson.kind === 'QUIZ');

  // Not every quiz has a free-text question, and the answer-key leak test needs
  // one specifically. Looking it up rather than assuming the first quiz has one
  // is what stops the test failing for a reason that has nothing to do with the
  // property it checks.
  const freeText = await prisma.question.findFirst({
    where: { kind: 'SHORT_TEXT', quiz: { lesson: { module: { courseId: course.id } } } },
    select: { quiz: { select: { lessonId: true } } },
  });

  if (!video?.videoAsset?.outputDir || !preview || !quiz || !freeText) {
    throw new Error(
      'The seed fixture is incomplete. Run `pnpm db:seed` before the integration lane.',
    );
  }

  return {
    studentId: student.id,
    instructorId: instructor.id,
    courseId: course.id,
    videoLessonId: video.id,
    previewLessonId: preview.id,
    quizLessonId: quiz.id,
    freeTextQuizLessonId: freeText.quiz.lessonId,
    assetOutputDir: video.videoAsset.outputDir,
    durationSeconds: video.videoAsset.durationSeconds,
  };
}

/** Put the student's enrollment and progress back to a known state. */
export async function resetStudent(fixture: SeedFixture): Promise<void> {
  await prisma.enrollment.update({
    where: { userId_courseId: { userId: fixture.studentId, courseId: fixture.courseId } },
    data: { status: 'ACTIVE' },
  });
  await prisma.lessonProgress.deleteMany({
    where: { userId: fixture.studentId, lesson: { module: { courseId: fixture.courseId } } },
  });
  await prisma.quizAttempt.deleteMany({ where: { userId: fixture.studentId } });
  await prisma.certificate.deleteMany({
    where: { enrollment: { userId: fixture.studentId, courseId: fixture.courseId } },
  });
}

/** Pull the ticket out of a rewritten playlist. */
export function ticketFrom(playlist: string): string {
  const match = /[?&]t=([^"&\s]+)/.exec(playlist);
  if (!match?.[1]) throw new Error('No ticket found in the playlist');
  return match[1];
}

/** Pull the first segment URL out of a media playlist. */
export function firstSegmentUrl(playlist: string): string {
  const line = playlist
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('#'));
  if (!line) throw new Error('No segment found in the playlist');
  return line;
}
