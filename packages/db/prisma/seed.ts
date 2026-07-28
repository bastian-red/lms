/**
 * Seed the LMS with a course that can actually be played.
 *
 * The hard part of seeding this project is video. A repo must not contain
 * binaries, and a course with no media cannot demonstrate the one thing this
 * project is about. So the seed **generates** its source clips with ffmpeg's
 * `testsrc2` and `sine` synthetic sources, then runs them through the real
 * transcode pipeline: the same ladder, the same AES-128 encryption, the same
 * playlists the instructor upload path produces.
 *
 * Consequences worth knowing:
 *   - The first run takes a minute or two. Subsequent runs skip any asset whose
 *     ladder is already on disk and marked READY.
 *   - `MEDIA_ROOT` must be writable and ffmpeg must be on PATH. Both are
 *     checked up front with a message that says what to do.
 *
 * Idempotent by construction: every write is an upsert keyed on something
 * stable, and `pruneStrayData` removes what the E2E suite leaves behind, so the
 * lane is repeatable rather than passing once against a fresh database.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  isAvailable,
  mediaConfigFromEnv,
  transcode,
  type MediaConfig,
  type RenditionResult,
} from '@lms/media';
import { PrismaClient, type Prisma } from '../generated/client';

const prisma = new PrismaClient();

/** Same format as the API's `hashPassword`. Duplicated rather than imported to
 * keep the seed free of a dependency on apps/api, which is a leaf, not a lib. */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

/**
 * The demo accounts. Password is the same for all three so the README can print
 * one line, and it is a development-only value that exists in the seed and
 * nowhere else.
 */
const DEMO_PASSWORD = 'course-demo-password';

const USERS = [
  { email: 'ada@lms.local', name: 'Ada Lovelace', role: 'STUDENT' as const },
  { email: 'grace@lms.local', name: 'Grace Hopper', role: 'INSTRUCTOR' as const },
  { email: 'admin@lms.local', name: 'Site Admin', role: 'ADMIN' as const },
];

/**
 * A synthetic cohort, so the instructor's retention charts have something to
 * show.
 *
 * Without it the analytics page is three empty axes, which demonstrates the
 * chart component and nothing about the feature. The distribution is
 * deliberately shaped like a real one — most people leave early, a few finish —
 * because a flat 100% curve would be just as useless as an empty one.
 *
 * Their progress is written as merged intervals through the same shape the
 * heartbeat produces, so `dropOffCurve` and the progress bars agree.
 */
const COHORT_SIZE = 12;

const cohortEmail = (index: number): string =>
  `cohort${String(index + 1).padStart(2, '0')}@lms.local`;

/**
 * What fraction of a lesson student `index` watched.
 *
 * A decaying curve: everyone starts, about half reach the middle, a third
 * finish. Deterministic, so re-seeding produces the same chart and a screenshot
 * in the README does not drift.
 */
function cohortCoverage(index: number, lessonIndex: number): number {
  const persistence = 1 - index / COHORT_SIZE; // 1.0 down to ~0.08
  const fatigue = 1 - lessonIndex * 0.12; // later lessons lose more people
  return Math.max(0, Math.min(1, persistence * fatigue));
}

interface SeedLesson {
  key: string;
  title: string;
  kind: 'VIDEO' | 'QUIZ';
  isPreview?: boolean;
  /** Seconds of synthetic video to generate. Kept short so seeding is fast. */
  seconds?: number;
  /** Which testsrc2 pattern, so the renditions are visually distinguishable. */
  hue?: number;
}

interface SeedModule {
  title: string;
  lessons: SeedLesson[];
}

const COURSE = {
  slug: 'adaptive-video-streaming',
  title: 'Adaptive Video Streaming, End to End',
  summary: 'Build an HLS pipeline that is genuinely unplayable without authorisation.',
  description: [
    'A practical course on shipping video that behaves: a real bitrate ladder,',
    'AES-128 encrypted segments, keys handed out per request, and progress that',
    'reflects what a student actually watched rather than where they dragged the',
    'scrubber.',
  ].join(' '),
  modules: [
    {
      title: 'Foundations',
      lessons: [
        {
          key: 'why-adaptive',
          title: 'Why adaptive streaming exists',
          kind: 'VIDEO',
          isPreview: true,
          seconds: 20,
          hue: 0,
        },
        { key: 'the-ladder', title: 'Designing a bitrate ladder', kind: 'VIDEO', seconds: 24, hue: 90 },
        { key: 'foundations-quiz', title: 'Foundations check', kind: 'QUIZ' },
      ],
    },
    {
      title: 'Protecting the content',
      lessons: [
        {
          key: 'aes-128',
          title: 'AES-128 and the key endpoint',
          kind: 'VIDEO',
          seconds: 28,
          hue: 180,
        },
        { key: 'protection-quiz', title: 'Access control check', kind: 'QUIZ' },
      ],
    },
  ] satisfies SeedModule[],
};

const QUIZZES: Record<
  string,
  {
    title: string;
    passingScore: number;
    questions: {
      kind: 'SINGLE' | 'MULTI' | 'TRUE_FALSE' | 'SHORT_TEXT';
      prompt: string;
      points: number;
      acceptedAnswers: string[];
      choices: { label: string; isCorrect: boolean }[];
    }[];
  }
> = {
  'foundations-quiz': {
    title: 'Foundations check',
    passingScore: 70,
    questions: [
      {
        kind: 'SINGLE',
        prompt: 'Which playlist advertises the available renditions?',
        points: 1,
        acceptedAnswers: [],
        choices: [
          { label: 'The master playlist', isCorrect: true },
          { label: 'The media playlist', isCorrect: false },
          { label: 'The init segment', isCorrect: false },
        ],
      },
      {
        kind: 'MULTI',
        prompt: 'Which of these must line up across renditions for switching to work?',
        points: 2,
        acceptedAnswers: [],
        choices: [
          { label: 'Segment boundaries', isCorrect: true },
          { label: 'Keyframe positions', isCorrect: true },
          { label: 'File names', isCorrect: false },
        ],
      },
      {
        kind: 'TRUE_FALSE',
        prompt: 'Upscaling a source to a taller rung improves quality.',
        points: 1,
        acceptedAnswers: [],
        choices: [
          { label: 'True', isCorrect: false },
          { label: 'False', isCorrect: true },
        ],
      },
    ],
  },
  'protection-quiz': {
    title: 'Access control check',
    passingScore: 70,
    questions: [
      {
        kind: 'SHORT_TEXT',
        prompt: 'In hex, what is the MPEG-TS sync byte that an encrypted segment must NOT start with?',
        points: 2,
        acceptedAnswers: ['0x47', '47'],
        choices: [],
      },
      {
        kind: 'SINGLE',
        prompt: 'Where does revoking a student mid-playback actually take effect?',
        points: 2,
        acceptedAnswers: [],
        choices: [
          { label: 'On the next key fetch', isCorrect: true },
          { label: 'When the ticket expires', isCorrect: false },
          { label: 'On the next page load', isCorrect: false },
        ],
      },
    ],
  },
};

async function main(): Promise<void> {
  const config = mediaConfigFromEnv();
  await preflight(config);

  console.log('==> Users');
  const users = new Map<string, string>();
  for (const user of USERS) {
    const row = await prisma.user.upsert({
      where: { email: user.email },
      // The password hash is only set on create. Re-running the seed must not
      // reset a password a developer changed while testing.
      update: { name: user.name, role: user.role },
      create: { ...user, passwordHash: hashPassword(DEMO_PASSWORD) },
      select: { id: true, email: true },
    });
    users.set(row.email, row.id);
  }
  const instructorId = users.get('grace@lms.local')!;
  const studentId = users.get('ada@lms.local')!;

  console.log('==> Course');
  const course = await prisma.course.upsert({
    where: { slug: COURSE.slug },
    update: {
      title: COURSE.title,
      summary: COURSE.summary,
      description: COURSE.description,
      status: 'PUBLISHED',
      instructorId,
    },
    create: {
      slug: COURSE.slug,
      title: COURSE.title,
      summary: COURSE.summary,
      description: COURSE.description,
      status: 'PUBLISHED',
      instructorId,
    },
    select: { id: true },
  });

  await pruneStrayData(course.id);

  console.log('==> Modules and lessons');
  const lessonIds = new Map<string, string>();
  for (const [moduleIndex, moduleSpec] of COURSE.modules.entries()) {
    const moduleRow = await upsertModule(course.id, moduleSpec.title, moduleIndex);
    for (const [lessonIndex, lessonSpec] of moduleSpec.lessons.entries()) {
      const lesson = await upsertLesson(moduleRow.id, lessonSpec, lessonIndex);
      lessonIds.set(lessonSpec.key, lesson.id);
    }
  }

  console.log('==> Quizzes');
  for (const [key, quiz] of Object.entries(QUIZZES)) {
    await upsertQuiz(lessonIds.get(key)!, quiz);
  }

  console.log('==> Video (generated, then transcoded through the real pipeline)');
  for (const moduleSpec of COURSE.modules) {
    for (const lessonSpec of moduleSpec.lessons) {
      if (lessonSpec.kind !== 'VIDEO') continue;
      await seedVideo(config, lessonIds.get(lessonSpec.key)!, lessonSpec);
    }
  }

  console.log('==> Enrollment');
  await prisma.enrollment.upsert({
    where: { userId_courseId: { userId: studentId, courseId: course.id } },
    // Reset to ACTIVE: the integration suite revokes this enrollment to prove
    // the key endpoint re-checks, and a later run would otherwise start revoked.
    update: { status: 'ACTIVE' },
    create: { userId: studentId, courseId: course.id, status: 'ACTIVE' },
  });

  console.log('==> Cohort watch history (so the retention charts mean something)');
  await seedCohort(course.id);

  console.log('\nSeed complete.');
  console.log(`  student:    ada@lms.local    / ${DEMO_PASSWORD}`);
  console.log(`  instructor: grace@lms.local  / ${DEMO_PASSWORD}`);
  console.log(`  admin:      admin@lms.local  / ${DEMO_PASSWORD}`);
}

/**
 * Fail with an actionable message rather than an ffmpeg stack trace 40 seconds
 * in. A missing binary is by far the most likely reason a clone cannot seed.
 */
async function preflight(config: MediaConfig): Promise<void> {
  await mkdir(config.root, { recursive: true });
  for (const [name, binary] of [
    ['ffmpeg', config.ffmpegPath],
    ['ffprobe', config.ffprobePath],
  ] as const) {
    if (!(await isAvailable(binary))) {
      throw new Error(
        `${name} is required to seed (it generates and transcodes the demo videos) but ` +
          `"${binary}" could not be run.\n` +
          `  Debian/Ubuntu: sudo apt install ffmpeg\n` +
          `  macOS:         brew install ffmpeg\n` +
          `  Or set ${name.toUpperCase()}_PATH in .env to an existing binary.`,
      );
    }
  }
}

async function upsertModule(
  courseId: string,
  title: string,
  position: number,
): Promise<{ id: string }> {
  const existing = await prisma.module.findFirst({
    where: { courseId, position },
    select: { id: true },
  });
  if (existing) {
    return prisma.module.update({ where: { id: existing.id }, data: { title }, select: { id: true } });
  }
  return prisma.module.create({ data: { courseId, title, position }, select: { id: true } });
}

async function upsertLesson(
  moduleId: string,
  spec: SeedLesson,
  position: number,
): Promise<{ id: string }> {
  const data = {
    title: spec.title,
    kind: spec.kind,
    isPreview: spec.isPreview ?? false,
    published: true,
  };
  const existing = await prisma.lesson.findFirst({
    where: { moduleId, position },
    select: { id: true },
  });
  if (existing) {
    return prisma.lesson.update({ where: { id: existing.id }, data, select: { id: true } });
  }
  return prisma.lesson.create({ data: { ...data, moduleId, position }, select: { id: true } });
}

async function upsertQuiz(
  lessonId: string,
  spec: (typeof QUIZZES)[string],
): Promise<void> {
  const quiz = await prisma.quiz.upsert({
    where: { lessonId },
    update: { title: spec.title, passingScore: spec.passingScore },
    create: { lessonId, title: spec.title, passingScore: spec.passingScore },
    select: { id: true },
  });

  // Questions are replaced wholesale rather than diffed. They are seed content,
  // the cascade cleans up choices, and a diff would have to reconcile choice
  // identity for no benefit. Attempts reference the quiz, not the question, so
  // nothing else breaks.
  await prisma.question.deleteMany({ where: { quizId: quiz.id } });
  for (const [index, question] of spec.questions.entries()) {
    await prisma.question.create({
      data: {
        quizId: quiz.id,
        kind: question.kind,
        prompt: question.prompt,
        points: question.points,
        position: index,
        acceptedAnswers: question.acceptedAnswers,
        choices: {
          create: question.choices.map((choice, choiceIndex) => ({
            label: choice.label,
            isCorrect: choice.isCorrect,
            position: choiceIndex,
          })),
        },
      },
    });
  }
}

/**
 * Generate a source clip and push it through the real transcode.
 *
 * Skipped when the asset is already READY and its master playlist is still on
 * disk. That pair of conditions matters: a database row alone would let a
 * `rm -rf var/media` leave every lesson pointing at nothing, and a file check
 * alone would miss a wiped database.
 */
async function seedVideo(config: MediaConfig, lessonId: string, spec: SeedLesson): Promise<void> {
  const existing = await prisma.videoAsset.findUnique({
    where: { lessonId },
    select: { id: true, status: true, outputDir: true },
  });

  if (
    existing?.status === 'READY' &&
    existing.outputDir &&
    existsSync(join(config.root, existing.outputDir, 'master.m3u8'))
  ) {
    console.log(`   - ${spec.title}: already transcoded, skipping`);
    return;
  }

  const asset = existing
    ? await prisma.videoAsset.update({
        where: { id: existing.id },
        data: { status: 'PROCESSING', lastError: null },
        select: { id: true },
      })
    : await prisma.videoAsset.create({
        data: { lessonId, status: 'PROCESSING', sourcePath: '' },
        select: { id: true },
      });

  const sourceRelative = join('sources', asset.id, 'source.mp4');
  const sourceAbsolute = join(config.root, sourceRelative);
  await mkdir(join(config.root, 'sources', asset.id), { recursive: true });

  console.log(`   - ${spec.title}: generating ${spec.seconds}s of source`);
  await generateSource(config, sourceAbsolute, spec);

  console.log(`   - ${spec.title}: transcoding`);
  const result = await transcode({
    config,
    sourcePath: sourceAbsolute,
    outputDir: join('assets', asset.id),
  });

  await prisma.videoAsset.update({
    where: { id: asset.id },
    data: {
      status: 'READY',
      sourcePath: sourceRelative,
      durationSeconds: result.probe.durationSeconds,
      width: result.probe.width,
      height: result.probe.height,
      outputDir: result.outputDir,
      renditions: toRenditionJson(result.renditions),
      encryptionKey: result.key,
      encryptionIv: result.iv,
      lastError: null,
    },
  });

  // A DONE job so the instructor dashboard and /health have realistic history
  // rather than an asset that appeared with no work behind it.
  await prisma.transcodeJob.create({
    data: { assetId: asset.id, status: 'DONE', attempts: 1 },
  });

  console.log(
    `   - ${spec.title}: ${result.renditions.map((r) => r.name).join(', ')} ` +
      `(${result.probe.durationSeconds.toFixed(1)}s)`,
  );
}

export function toRenditionJson(renditions: RenditionResult[]): Prisma.InputJsonValue {
  return renditions.map((rendition) => ({
    name: rendition.name,
    height: rendition.height,
    bitrateKbps: rendition.bitrateKbps,
    playlist: rendition.playlist,
    segmentCount: rendition.segmentCount,
  }));
}

/**
 * Synthesise a source clip with ffmpeg's built-in generators.
 *
 * `testsrc2` produces a moving pattern with a burnt-in timecode, which is
 * exactly what a demo of seek-resistant progress tracking needs: the frame
 * itself shows where you are. `sine` gives a real audio track, so the pipeline
 * exercises the audio branch rather than the `-an` shortcut.
 *
 * 720p at 30fps so all three rungs of the ladder apply.
 */
async function generateSource(
  config: MediaConfig,
  outputPath: string,
  spec: SeedLesson,
): Promise<void> {
  const { runOrThrow } = await import('@lms/media');
  const seconds = spec.seconds ?? 20;
  await rm(outputPath, { force: true });
  await runOrThrow(
    config.ffmpegPath,
    [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
      '-f',
      'lavfi',
      // A different tone per lesson, so an ear can tell them apart in the demo.
      '-i',
      `sine=frequency=${220 + (spec.hue ?? 0)}:duration=${seconds}`,
      '-vf',
      `hue=h=${spec.hue ?? 0}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      // The source only has to be decodable; the ladder is what gets tuned.
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      outputPath,
    ],
    { timeoutMs: 120_000 },
  );
}

/**
 * Enroll a synthetic cohort and give them watch history.
 *
 * The intervals are written directly rather than through the heartbeat
 * endpoint: that endpoint deliberately caps new coverage at wall-clock elapsed,
 * so seeding a realistic cohort through it would take as long as the videos are
 * long. The shape written here is exactly what the heartbeat would have merged.
 */
async function seedCohort(courseId: string): Promise<void> {
  const lessons = await prisma.lesson.findMany({
    where: { kind: 'VIDEO', published: true, module: { courseId } },
    orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
    select: { id: true, videoAsset: { select: { durationSeconds: true } } },
  });

  for (let index = 0; index < COHORT_SIZE; index += 1) {
    const email = cohortEmail(index);
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        name: `Student ${String(index + 1).padStart(2, '0')}`,
        passwordHash: hashPassword(DEMO_PASSWORD),
      },
      select: { id: true },
    });

    await prisma.enrollment.upsert({
      where: { userId_courseId: { userId: user.id, courseId } },
      update: { status: 'ACTIVE' },
      create: { userId: user.id, courseId, status: 'ACTIVE' },
    });

    for (const [lessonIndex, lesson] of lessons.entries()) {
      const duration = lesson.videoAsset?.durationSeconds ?? 0;
      if (duration <= 0) continue;

      const coverage = cohortCoverage(index, lessonIndex);
      if (coverage <= 0) continue;

      // One contiguous run from the start, which is what watching-then-leaving
      // actually looks like. Rounded to centiseconds so it round-trips through
      // the same storage shape the API writes.
      const watched = Math.min(duration, Math.round(duration * coverage * 100) / 100);
      if (watched < 1) continue;

      const completed = watched / duration >= 0.9;
      await prisma.lessonProgress.upsert({
        where: { userId_lessonId: { userId: user.id, lessonId: lesson.id } },
        update: {
          watchedIntervals: [[0, watched]],
          secondsWatched: watched,
          completed,
          completedAt: completed ? new Date() : null,
        },
        create: {
          userId: user.id,
          lessonId: lesson.id,
          watchedIntervals: [[0, watched]],
          secondsWatched: watched,
          completed,
          completedAt: completed ? new Date() : null,
        },
      });
    }
  }
  console.log(`   - ${COHORT_SIZE} students with watch history`);
}

/**
 * Remove what the E2E and integration suites leave behind.
 *
 * Upserts alone can only add and update, so without this the "clean slate" the
 * seed promises is not true: a suite that enrolled three throwaway students and
 * banked forty quiz attempts leaves all of it, and the next run's analytics
 * assertions see numbers from the previous run.
 *
 * Scoped to the seeded course and to accounts outside the demo set, so a
 * developer's own test data in another course survives.
 */
async function pruneStrayData(courseId: string): Promise<void> {
  // The cohort is seed data, not stray data: deleting it here and recreating it
  // below would work, but it would also churn every id on every seed and make
  // the analytics numbers move for no reason.
  const demoEmails = [
    ...USERS.map((user) => user.email),
    ...Array.from({ length: COHORT_SIZE }, (_, index) => cohortEmail(index)),
  ];

  // Progress and attempts belonging to throwaway accounts.
  const strays = await prisma.user.findMany({
    where: { email: { notIn: demoEmails } },
    select: { id: true },
  });
  if (strays.length > 0) {
    const strayIds = strays.map((user) => user.id);
    await prisma.quizAttempt.deleteMany({ where: { userId: { in: strayIds } } });
    await prisma.lessonProgress.deleteMany({ where: { userId: { in: strayIds } } });
    // Certificates and enrollments cascade from the user row.
    await prisma.user.deleteMany({ where: { id: { in: strayIds } } });
  }

  // The demo student's own progress, so every run starts at 0% and the
  // completion flow is demonstrable again. Scoped to the accounts a person
  // signs in as, so the cohort's history — which is what the retention charts
  // are drawn from — survives.
  const resettable = await prisma.user.findMany({
    where: { email: { in: USERS.map((user) => user.email) } },
    select: { id: true },
  });
  const resettableIds = resettable.map((user) => user.id);
  await prisma.lessonProgress.deleteMany({
    where: { userId: { in: resettableIds }, lesson: { module: { courseId } } },
  });
  await prisma.quizAttempt.deleteMany({
    where: { userId: { in: resettableIds }, quiz: { lesson: { module: { courseId } } } },
  });
  await prisma.certificate.deleteMany({ where: { enrollment: { courseId } } });

  // Courses the authoring E2E spec created. Keyed on the slug prefix the spec
  // uses, so a course a developer made by hand is left alone.
  await prisma.course.deleteMany({
    where: { slug: { startsWith: 'e2e-' }, id: { not: courseId } },
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
