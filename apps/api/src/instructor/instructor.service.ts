import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isDuplicateLiveJob } from '@lms/db';
import { isAllowedUploadName, storeUpload } from '@lms/media';
import {
  dropOffCurve,
  lessonEngagement,
  parseIntervals,
  type CreateCourseInput,
  type CreateLessonInput,
  type CreateModuleInput,
  type UpdateCourseInput,
  type UpsertQuizInput,
} from '@lms/shared';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Course authoring, video upload, and the analytics an instructor acts on.
 *
 * Every method takes the actor and re-checks ownership against the database.
 * The RolesGuard proves the caller is *an* instructor; it cannot prove they own
 * *this* course, and treating the role as sufficient is how one instructor ends
 * up able to edit another's material.
 */
@Injectable()
export class InstructorService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async createCourse(instructorId: string, input: CreateCourseInput) {
    const slug = await this.uniqueSlug(input.title);
    return this.prisma.course.create({
      data: { ...input, slug, instructorId },
      select: { id: true, slug: true, title: true, status: true },
    });
  }

  async updateCourse(actorId: string, courseId: string, input: UpdateCourseInput) {
    await this.assertOwnsCourse(actorId, courseId);
    return this.prisma.course.update({
      where: { id: courseId },
      data: input,
      select: { id: true, slug: true, title: true, status: true },
    });
  }

  /**
   * The full authoring view of a course: unpublished lessons, transcode status,
   * and the last error for anything that failed.
   */
  async courseForEditing(actorId: string, courseId: string) {
    await this.assertOwnsCourse(actorId, courseId);
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        description: true,
        status: true,
        modules: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            position: true,
            lessons: {
              orderBy: { position: 'asc' },
              select: {
                id: true,
                title: true,
                kind: true,
                position: true,
                isPreview: true,
                published: true,
                quiz: { select: { id: true, title: true, _count: { select: { questions: true } } } },
                videoAsset: {
                  select: {
                    id: true,
                    status: true,
                    durationSeconds: true,
                    width: true,
                    height: true,
                    renditions: true,
                    lastError: true,
                    // The key and IV are deliberately absent from this select.
                    // The instructor UI has no use for them, and a projection
                    // that includes them is a projection that can leak them.
                    jobs: {
                      orderBy: { createdAt: 'desc' },
                      take: 1,
                      select: { status: true, attempts: true, lastError: true, availableAt: true },
                    },
                  },
                },
              },
            },
          },
        },
        _count: { select: { enrollments: true } },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  async addModule(actorId: string, courseId: string, input: CreateModuleInput) {
    await this.assertOwnsCourse(actorId, courseId);
    const last = await this.prisma.module.findFirst({
      where: { courseId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.module.create({
      data: { courseId, title: input.title, position: (last?.position ?? -1) + 1 },
      select: { id: true, title: true, position: true },
    });
  }

  async addLesson(actorId: string, courseId: string, input: CreateLessonInput) {
    await this.assertOwnsCourse(actorId, courseId);
    const moduleRow = await this.prisma.module.findUnique({
      where: { id: input.moduleId },
      select: { courseId: true },
    });
    if (!moduleRow || moduleRow.courseId !== courseId) {
      throw new NotFoundException('Module not found in this course');
    }

    const last = await this.prisma.lesson.findFirst({
      where: { moduleId: input.moduleId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    // Exactly one preview per course. Two free lessons is a pricing decision,
    // not a UI accident, so setting a new one clears the old.
    if (input.isPreview) {
      await this.prisma.lesson.updateMany({
        where: { module: { courseId }, isPreview: true },
        data: { isPreview: false },
      });
    }

    return this.prisma.lesson.create({
      data: {
        moduleId: input.moduleId,
        title: input.title,
        kind: input.kind,
        isPreview: input.isPreview,
        position: (last?.position ?? -1) + 1,
      },
      select: { id: true, title: true, kind: true, position: true },
    });
  }

  /**
   * Accept a video upload and queue it for transcoding.
   *
   * The asset row and the job are written in one transaction, which is the
   * whole reason the queue is a table. With Redis, a crash between "asset
   * created" and "job enqueued" leaves an asset nothing will ever process, and
   * nothing in the system knows it is stuck.
   */
  async uploadVideo(
    actorId: string,
    lessonId: string,
    file: { originalname: string; buffer: Buffer; size: number },
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        kind: true,
        module: { select: { course: { select: { id: true, instructorId: true } } } },
        videoAsset: { select: { id: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.module.course.instructorId !== actorId) {
      throw new ForbiddenException('Not your course');
    }
    if (lesson.kind !== 'VIDEO') {
      throw new BadRequestException('This lesson is a quiz, not a video');
    }
    if (!isAllowedUploadName(file.originalname)) {
      throw new BadRequestException('Upload a video file (.mp4, .mov, .mkv, .webm, .m4v, .avi)');
    }
    if (file.size <= 0) throw new BadRequestException('The uploaded file is empty');
    if (file.size > this.config.maxUploadBytes) {
      throw new BadRequestException(
        `File is larger than the ${Math.floor(this.config.maxUploadBytes / 1024 / 1024)}MB limit`,
      );
    }

    const asset = lesson.videoAsset
      ? await this.prisma.videoAsset.update({
          where: { id: lesson.videoAsset.id },
          data: { status: 'PENDING', lastError: null },
          select: { id: true },
        })
      : await this.prisma.videoAsset.create({
          data: { lessonId, status: 'PENDING', sourcePath: '' },
          select: { id: true },
        });

    // Written to disk before the transaction: a file on disk with no row is
    // garbage the worker never sees, while a row pointing at a file that does
    // not exist is a job that fails every retry.
    const stored = await storeUpload(this.config.media, asset.id, file.originalname, file.buffer);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.videoAsset.update({
          where: { id: asset.id },
          data: { sourcePath: stored.relativePath, sourceBytes: stored.bytes },
        });
        const job = await tx.transcodeJob.create({
          data: { assetId: asset.id },
          select: { id: true, status: true },
        });
        return { assetId: asset.id, jobId: job.id, status: job.status };
      });
    } catch (error) {
      if (isDuplicateLiveJob(error)) {
        // A job is already queued or running for this asset. Re-uploading while
        // one is in flight is a normal impatient-user action, not an error: the
        // in-flight job will pick up the file that is now on disk.
        const existing = await this.prisma.transcodeJob.findFirst({
          where: { assetId: asset.id, status: { in: ['QUEUED', 'RUNNING'] } },
          select: { id: true, status: true },
        });
        if (existing) {
          return { assetId: asset.id, jobId: existing.id, status: existing.status };
        }
      }
      throw error;
    }
  }

  /** Replace a lesson's quiz. */
  async upsertQuiz(actorId: string, lessonId: string, input: UpsertQuizInput) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, kind: true, module: { select: { course: { select: { instructorId: true } } } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.module.course.instructorId !== actorId) {
      throw new ForbiddenException('Not your course');
    }
    if (lesson.kind !== 'QUIZ') throw new BadRequestException('This lesson is not a quiz');

    for (const question of input.questions) {
      if (question.kind === 'SHORT_TEXT') {
        if (question.acceptedAnswers.length === 0) {
          throw new BadRequestException(
            `"${question.prompt}" is a free-text question with no accepted answers, so nobody can get it right`,
          );
        }
      } else if (!question.choices.some((choice) => choice.isCorrect)) {
        // A choice question with no correct option marks every student wrong,
        // which reads as a platform bug rather than as the content mistake it is.
        throw new BadRequestException(`"${question.prompt}" has no correct choice`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const quiz = await tx.quiz.upsert({
        where: { lessonId },
        update: { title: input.title, passingScore: input.passingScore },
        create: { lessonId, title: input.title, passingScore: input.passingScore },
        select: { id: true },
      });
      // Replaced wholesale rather than diffed. Attempts reference the quiz, not
      // the question, so history survives; reconciling choice identity across an
      // edit would buy nothing.
      await tx.question.deleteMany({ where: { quizId: quiz.id } });
      for (const [index, question] of input.questions.entries()) {
        await tx.question.create({
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
      return { id: quiz.id };
    });
  }

  /**
   * Where students stop watching, per video lesson.
   *
   * The curve is computed from the same merged intervals progress uses, so the
   * chart and the progress bar cannot disagree.
   */
  async analytics(actorId: string, courseId: string) {
    await this.assertOwnsCourse(actorId, courseId);

    const lessons = await this.prisma.lesson.findMany({
      where: { module: { courseId }, kind: 'VIDEO', published: true },
      orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
      select: {
        id: true,
        title: true,
        videoAsset: { select: { durationSeconds: true } },
        progress: { select: { watchedIntervals: true } },
      },
    });

    const enrolled = await this.prisma.enrollment.count({
      where: { courseId, status: { in: ['ACTIVE', 'COMPLETED'] } },
    });

    return {
      enrolled,
      lessons: lessons.map((lesson) => {
        const duration = lesson.videoAsset?.durationSeconds ?? 0;
        const perStudent = lesson.progress.map((row) => parseIntervals(row.watchedIntervals));
        return {
          id: lesson.id,
          title: lesson.title,
          durationSeconds: duration,
          engagement: lessonEngagement(perStudent, duration, this.config.completionThreshold),
          curve: dropOffCurve(perStudent, duration),
        };
      }),
    };
  }

  private async assertOwnsCourse(actorId: string, courseId: string): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.instructorId !== actorId) throw new ForbiddenException('Not your course');
  }

  /**
   * A readable slug that is actually unique.
   *
   * Retries with a numeric suffix rather than appending a random id, because the
   * slug is in the URL a student shares. Bounded, so a pathological title cannot
   * loop forever.
   */
  private async uniqueSlug(title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'course';

    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
      const taken = await this.prisma.course.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    // Fifty collisions on one title means something is wrong; a timestamped
    // slug is ugly but always works and never blocks the instructor.
    return `${base}-${Date.now()}`;
  }
}
