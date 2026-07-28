import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isDuplicateCertificate } from '@lms/db';
import { generateSerial, normalizeSerial, writeCertificate } from '@lms/certificates';
import { courseCompleted, type Channel } from '@lms/notifications';
import type { CertificateSummary, CertificateVerification } from '@lms/shared';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, type AppConfig } from '../config/config';
import { NOTIFICATIONS } from '../core/core.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Certificate issuing and public verification.
 *
 * Two properties this file exists to hold:
 *
 *   **A certificate means the course was actually finished.** Every published
 *   lesson complete, every quiz passed. The check reads the current state of
 *   the database, so a course that gains a lesson after a student finished it
 *   does not retroactively invalidate the certificate they already hold, but a
 *   student mid-course cannot obtain one.
 *
 *   **Issuing is idempotent.** Two concurrent requests must not produce two
 *   serials. The unique index on `enrollmentId` is the arbiter: the loser
 *   catches the violation and reads back the winner's row, which is the only
 *   version of this that is correct under concurrency. A read-then-write check
 *   loses the race by construction.
 */
@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFICATIONS) private readonly mail: Channel,
  ) {}

  /**
   * Issue, or return the existing certificate.
   *
   * 409 when the course is not finished, with the remaining lessons named:
   * "not eligible" with no reason is a support ticket waiting to happen.
   */
  async issue(userId: string, courseId: string): Promise<CertificateSummary> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: {
        id: true,
        status: true,
        certificate: { select: certificateSelect },
        user: { select: { name: true, email: true } },
        course: {
          select: { id: true, title: true, instructor: { select: { name: true } } },
        },
      },
    });
    if (!enrollment) throw new NotFoundException('Not enrolled in this course');
    if (enrollment.certificate) {
      // Already issued. Returning it rather than 409ing makes the endpoint safe
      // to call from a page render.
      return this.toSummary(enrollment.certificate);
    }
    if (enrollment.status === 'REVOKED') {
      throw new ConflictException('This enrollment has been revoked');
    }

    const outstanding = await this.outstandingLessons(userId, courseId);
    if (outstanding.length > 0) {
      throw new ConflictException({
        message: 'Course is not complete yet',
        outstanding: outstanding.map((lesson) => lesson.title),
      });
    }

    const studentName = enrollment.user.name ?? enrollment.user.email;
    const serial = generateSerial();

    let certificate;
    try {
      certificate = await this.prisma.$transaction(async (tx) => {
        const created = await tx.certificate.create({
          data: {
            enrollmentId: enrollment.id,
            serial,
            studentName,
            courseTitle: enrollment.course.title,
          },
          select: certificateSelect,
        });
        // The enrollment moves to COMPLETED in the same transaction, so a
        // certificate row and a still-ACTIVE enrollment cannot coexist.
        await tx.enrollment.update({
          where: { id: enrollment.id },
          data: { status: 'COMPLETED' },
        });
        return created;
      });
    } catch (error) {
      if (isDuplicateCertificate(error)) {
        // Lost the race. The winner's row is the answer; re-reading it is what
        // makes two concurrent requests return one serial rather than two.
        const existing = await this.prisma.certificate.findUnique({
          where: { enrollmentId: enrollment.id },
          select: certificateSelect,
        });
        if (existing) return this.toSummary(existing);
      }
      throw error;
    }

    await this.renderPdf(certificate.id, {
      serial: certificate.serial,
      studentName: certificate.studentName,
      courseTitle: certificate.courseTitle,
      instructorName: enrollment.course.instructor.name ?? 'The instructor',
      issuedAt: certificate.issuedAt,
    });

    // After the transaction commits, and through a channel that never throws:
    // the certificate is earned whether or not the email is delivered.
    const message = courseCompleted({
      studentName,
      courseTitle: certificate.courseTitle,
      serial: certificate.serial,
      verifyUrl: this.verifyUrl(certificate.serial),
    });
    await this.mail.send({ to: enrollment.user.email, ...message });

    return this.toSummary(certificate);
  }

  /**
   * Lessons still standing between this student and a certificate.
   *
   * Published lessons only. An instructor's unpublished draft must not block a
   * student who finished everything that was actually visible to them.
   */
  async outstandingLessons(
    userId: string,
    courseId: string,
  ): Promise<{ id: string; title: string }[]> {
    const lessons = await this.prisma.lesson.findMany({
      where: { published: true, module: { courseId } },
      orderBy: [{ module: { position: 'asc' } }, { position: 'asc' }],
      select: {
        id: true,
        title: true,
        kind: true,
        quiz: { select: { id: true } },
        progress: { where: { userId }, select: { completed: true }, take: 1 },
      },
    });

    // A course with no published lessons cannot be completed. Otherwise an
    // empty draft would hand out certificates to anyone who enrolled.
    if (lessons.length === 0) {
      return [{ id: courseId, title: 'This course has no published lessons yet' }];
    }

    const quizIds = lessons.map((lesson) => lesson.quiz?.id).filter((id): id is string => !!id);
    const passed = new Set(
      (
        await this.prisma.quizAttempt.findMany({
          where: { userId, passed: true, quizId: { in: quizIds } },
          select: { quizId: true },
        })
      ).map((attempt) => attempt.quizId),
    );

    return lessons
      .filter((lesson) => {
        // A quiz lesson needs a passing attempt, not merely a progress row.
        // Checking only `completed` would let a bug elsewhere that sets the flag
        // hand out a certificate for a quiz nobody passed.
        if (lesson.quiz) return !passed.has(lesson.quiz.id);
        return lesson.progress[0]?.completed !== true;
      })
      .map((lesson) => ({ id: lesson.id, title: lesson.title }));
  }

  /** The student's own certificate for a course, if any. */
  async forEnrollment(userId: string, courseId: string): Promise<CertificateSummary | null> {
    const certificate = await this.prisma.certificate.findFirst({
      where: { enrollment: { userId, courseId } },
      select: certificateSelect,
    });
    return certificate ? this.toSummary(certificate) : null;
  }

  /**
   * Public verification by serial.
   *
   * Returns a deliberately small shape and never 404s: a "not found" status code
   * plus a 200 for a hit turns the endpoint into an oracle for guessing serials.
   * It answers `{valid: false}` with the same shape and the same latency
   * characteristics either way.
   */
  async verify(rawSerial: string): Promise<CertificateVerification> {
    const serial = normalizeSerial(rawSerial);
    const certificate =
      serial === ''
        ? null
        : await this.prisma.certificate.findUnique({
            where: { serial },
            select: { serial: true, courseTitle: true, studentName: true, issuedAt: true },
          });

    if (!certificate) {
      return { valid: false, serial, courseTitle: null, studentName: null, issuedAt: null };
    }
    return {
      valid: true,
      serial: certificate.serial,
      courseTitle: certificate.courseTitle,
      studentName: certificate.studentName,
      issuedAt: certificate.issuedAt.toISOString(),
    };
  }

  /**
   * The PDF bytes, rendering them if the file is missing.
   *
   * Media volumes get wiped and containers get rebuilt; a certificate whose row
   * exists must always be downloadable, so a missing file is a re-render rather
   * than a 404.
   */
  async pdf(userId: string, serial: string): Promise<{ bytes: Buffer; filename: string }> {
    const normalized = normalizeSerial(serial);
    const certificate = await this.prisma.certificate.findFirst({
      where: { serial: normalized, enrollment: { userId } },
      select: {
        ...certificateSelect,
        enrollment: { select: { course: { select: { instructor: { select: { name: true } } } } } },
      },
    });
    if (!certificate) throw new NotFoundException('Certificate not found');

    const bytes = await this.renderPdf(certificate.id, {
      serial: certificate.serial,
      studentName: certificate.studentName,
      courseTitle: certificate.courseTitle,
      instructorName: certificate.enrollment.course.instructor.name ?? 'The instructor',
      issuedAt: certificate.issuedAt,
    });
    return { bytes, filename: `${certificate.serial}.pdf` };
  }

  private async renderPdf(
    certificateId: string,
    data: {
      serial: string;
      studentName: string;
      courseTitle: string;
      instructorName: string;
      issuedAt: Date;
    },
  ): Promise<Buffer> {
    const relativePath = join('certificates', `${data.serial}.pdf`);
    const absolutePath = join(this.config.media.root, relativePath);

    const bytes = await writeCertificate(absolutePath, {
      ...data,
      verifyUrl: this.verifyUrl(data.serial),
    });

    // Only record the path once the bytes are actually on disk, so a crash
    // mid-write leaves the row saying "no PDF" rather than pointing at a
    // truncated file.
    if (existsSync(absolutePath)) {
      await this.prisma.certificate.update({
        where: { id: certificateId },
        data: { pdfPath: relativePath },
      });
    }
    return bytes;
  }

  private verifyUrl(serial: string): string {
    return `${this.config.appBaseUrl}/verify/${encodeURIComponent(serial)}`;
  }

  private toSummary(row: {
    serial: string;
    issuedAt: Date;
    courseTitle: string;
    studentName: string;
  }): CertificateSummary {
    return {
      serial: row.serial,
      issuedAt: row.issuedAt.toISOString(),
      courseTitle: row.courseTitle,
      studentName: row.studentName,
      downloadPath: `/certificates/${encodeURIComponent(row.serial)}/pdf`,
    };
  }
}

const certificateSelect = {
  id: true,
  serial: true,
  studentName: true,
  courseTitle: true,
  issuedAt: true,
} as const;
