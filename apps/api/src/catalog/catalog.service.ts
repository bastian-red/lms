import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CourseDetail,
  CourseStatus,
  CourseSummary,
  EnrollmentSummary,
  LessonKind,
  ModuleSummary,
  VideoStatus,
} from '@lms/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read side of the catalogue.
 *
 * Everything here is a projection built by naming fields explicitly. The
 * temptation on a read path is to hand Prisma a nested `include` and return the
 * result, which works right up until someone adds a column — `passwordHash` on
 * the instructor, `encryptionKey` on the asset, `isCorrect` on a choice — and it
 * ships to the browser without anyone deciding to.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Published courses, for the public catalogue. */
  async listPublished(): Promise<CourseSummary[]> {
    const courses = await this.prisma.course.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { createdAt: 'asc' },
      select: courseSummarySelect,
    });
    return courses.map(toCourseSummary);
  }

  /** Everything an instructor owns, published or not. */
  async listForInstructor(instructorId: string): Promise<CourseSummary[]> {
    const courses = await this.prisma.course.findMany({
      where: { instructorId },
      orderBy: { createdAt: 'desc' },
      select: courseSummarySelect,
    });
    return courses.map(toCourseSummary);
  }

  /**
   * One course with its syllabus.
   *
   * `viewerId` is optional: the page is public, and a signed-in viewer
   * additionally gets their enrollment and completed-lesson set. Draft courses
   * are visible only to their instructor, so the "unpublished" state is real
   * rather than a UI convention.
   */
  async detail(slug: string, viewerId?: string): Promise<CourseDetail> {
    const course = await this.prisma.course.findUnique({
      where: { slug },
      select: {
        ...courseSummarySelect,
        description: true,
        modules: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            position: true,
            lessons: {
              where: { published: true },
              orderBy: { position: 'asc' },
              select: {
                id: true,
                title: true,
                kind: true,
                position: true,
                isPreview: true,
                videoAsset: { select: { status: true, durationSeconds: true } },
              },
            },
          },
        },
      },
    });

    if (!course) throw new NotFoundException('Course not found');
    if (course.status !== 'PUBLISHED' && course.instructorId !== viewerId) {
      // 404 rather than 403: an unpublished course should not be discoverable
      // at all, and a 403 confirms the slug exists.
      throw new NotFoundException('Course not found');
    }

    const modules: ModuleSummary[] = course.modules.map((module) => ({
      id: module.id,
      title: module.title,
      position: module.position,
      lessons: module.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        kind: lesson.kind as LessonKind,
        position: lesson.position,
        durationSeconds: lesson.videoAsset?.durationSeconds ?? 0,
        isPreview: lesson.isPreview,
        videoStatus: (lesson.videoAsset?.status as VideoStatus | undefined) ?? null,
      })),
    }));

    return {
      ...toCourseSummary(course),
      description: course.description,
      modules,
      enrollment: viewerId ? await this.enrollmentSummary(viewerId, course.id) : null,
    };
  }

  /**
   * A student's enrollment with progress.
   *
   * Progress is the share of *published* lessons completed, computed from the
   * progress rows rather than stored on the enrollment. A denormalised counter
   * would have to be updated from three different places (a heartbeat, a quiz
   * submission, an instructor publishing a new lesson) and would be wrong the
   * first time one of them was missed.
   */
  async enrollmentSummary(userId: string, courseId: string): Promise<EnrollmentSummary | null> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: {
        id: true,
        status: true,
        enrolledAt: true,
        certificate: { select: { serial: true } },
      },
    });
    if (!enrollment) return null;

    const [lessons, completed] = await Promise.all([
      this.prisma.lesson.findMany({
        where: { published: true, module: { courseId } },
        select: { id: true },
      }),
      this.prisma.lessonProgress.findMany({
        where: { userId, completed: true, lesson: { published: true, module: { courseId } } },
        select: { lessonId: true },
      }),
    ]);

    const completedLessonIds = completed.map((row) => row.lessonId);
    return {
      id: enrollment.id,
      status: enrollment.status,
      enrolledAt: enrollment.enrolledAt.toISOString(),
      // A course with no lessons is 0%, not NaN and not 100%.
      progress: lessons.length > 0 ? completedLessonIds.length / lessons.length : 0,
      completedLessonIds,
      certificateSerial: enrollment.certificate?.serial ?? null,
    };
  }

  /** Courses this student is enrolled in, with progress. */
  async myCourses(userId: string): Promise<(CourseSummary & { enrollment: EnrollmentSummary })[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
      orderBy: { enrolledAt: 'desc' },
      select: { course: { select: courseSummarySelect } },
    });

    const out: (CourseSummary & { enrollment: EnrollmentSummary })[] = [];
    for (const row of enrollments) {
      const summary = await this.enrollmentSummary(userId, row.course.id);
      if (summary) out.push({ ...toCourseSummary(row.course), enrollment: summary });
    }
    return out;
  }
}

/**
 * The one place the summary shape is defined.
 *
 * `_count` rather than loading the enrollments: a popular course would
 * otherwise pull every enrollment row into memory to produce one integer.
 */
const courseSummarySelect = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  status: true,
  instructorId: true,
  instructor: { select: { id: true, name: true } },
  modules: {
    select: {
      lessons: {
        where: { published: true },
        select: { id: true, videoAsset: { select: { durationSeconds: true } } },
      },
    },
  },
  _count: { select: { enrollments: true } },
} as const;

type CourseSummaryRow = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: string;
  instructorId: string;
  instructor: { id: string; name: string | null };
  modules: { lessons: { id: string; videoAsset: { durationSeconds: number } | null }[] }[];
  _count: { enrollments: number };
};

function toCourseSummary(course: CourseSummaryRow): CourseSummary {
  const lessons = course.modules.flatMap((module) => module.lessons);
  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    summary: course.summary,
    status: course.status as CourseStatus,
    instructor: { id: course.instructor.id, name: course.instructor.name },
    lessonCount: lessons.length,
    totalDurationSeconds: lessons.reduce(
      (total, lesson) => total + (lesson.videoAsset?.durationSeconds ?? 0),
      0,
    ),
    enrolledCount: course._count.enrollments,
  };
}
