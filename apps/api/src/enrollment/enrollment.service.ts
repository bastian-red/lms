import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueViolation } from '@lms/db';
import type { EnrollmentSummary } from '@lms/shared';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Enroll, idempotently.
   *
   * Double-clicking "Enroll" is the common case, not an attack, so a second
   * request returns the existing enrollment rather than a 409. The unique index
   * on (userId, courseId) is what makes that safe under concurrency; a
   * read-then-create would let two simultaneous clicks both pass the check.
   *
   * A previously revoked enrollment is *not* silently reactivated. Revocation
   * is an administrative decision, and self-service re-enrollment would undo it.
   */
  async enroll(userId: string, courseId: string): Promise<EnrollmentSummary> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, status: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.status !== 'PUBLISHED') {
      throw new ForbiddenException('This course is not open for enrollment');
    }

    const existing = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { status: true },
    });
    if (existing?.status === 'REVOKED') {
      throw new ForbiddenException('Your access to this course was revoked');
    }

    if (!existing) {
      try {
        await this.prisma.enrollment.create({ data: { userId, courseId } });
      } catch (error) {
        // Lost a race with another click. The row now exists, which is exactly
        // the outcome asked for.
        if (!isUniqueViolation(error)) throw error;
      }
    }

    const summary = await this.catalog.enrollmentSummary(userId, courseId);
    if (!summary) throw new ConflictException('Enrollment could not be created');
    return summary;
  }

  /**
   * Revoke a student's access.
   *
   * The single most important thing about this method is what it does *not* do:
   * it does not delete the certificate. A certificate that was legitimately
   * earned stays valid and stays verifiable, because revoking future access is
   * a different decision from retracting a past achievement.
   *
   * Because the key endpoint re-reads enrollment on every fetch, this takes
   * effect on the student's next key request — mid-playback, with a still-valid
   * ticket in their browser.
   */
  async revoke(actorId: string, actorRole: string, enrollmentId: string): Promise<void> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { id: true, course: { select: { instructorId: true } } },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');

    const allowed = actorRole === 'ADMIN' || enrollment.course.instructorId === actorId;
    if (!allowed) throw new ForbiddenException('Not your course');

    await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: { status: 'REVOKED' },
    });
  }

  /** Restore a revoked enrollment. Instructor or admin only. */
  async reinstate(actorId: string, actorRole: string, enrollmentId: string): Promise<void> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        certificate: { select: { id: true } },
        course: { select: { instructorId: true } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');

    const allowed = actorRole === 'ADMIN' || enrollment.course.instructorId === actorId;
    if (!allowed) throw new ForbiddenException('Not your course');

    await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      // A student who already holds a certificate goes back to COMPLETED, not
      // to ACTIVE: the enrollment status is derived from what they achieved,
      // and demoting it would make the course look unfinished on their profile.
      data: { status: enrollment.certificate ? 'COMPLETED' : 'ACTIVE' },
    });
  }

  /** The roster an instructor sees for one course. */
  async roster(actorId: string, actorRole: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (actorRole !== 'ADMIN' && course.instructorId !== actorId) {
      throw new ForbiddenException('Not your course');
    }

    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId },
      orderBy: { enrolledAt: 'asc' },
      select: {
        id: true,
        status: true,
        enrolledAt: true,
        user: { select: { id: true, name: true, email: true } },
        certificate: { select: { serial: true } },
      },
    });

    const lessonCount = await this.prisma.lesson.count({
      where: { published: true, module: { courseId } },
    });

    const completions = await this.prisma.lessonProgress.groupBy({
      by: ['userId'],
      where: { completed: true, lesson: { published: true, module: { courseId } } },
      _count: { lessonId: true },
    });
    const completedByUser = new Map(completions.map((row) => [row.userId, row._count.lessonId]));

    return enrollments.map((enrollment) => ({
      id: enrollment.id,
      status: enrollment.status,
      enrolledAt: enrollment.enrolledAt.toISOString(),
      student: enrollment.user,
      completedLessons: completedByUser.get(enrollment.user.id) ?? 0,
      lessonCount,
      certificateSerial: enrollment.certificate?.serial ?? null,
    }));
  }
}
