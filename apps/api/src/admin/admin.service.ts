import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Role } from '@lms/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async users() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      // No passwordHash. An admin screen has no use for it, and a projection
      // that includes it is a projection that can end up in a log or a browser.
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        _count: { select: { enrollments: true, courses: true } },
      },
    });
  }

  /**
   * Change a user's role.
   *
   * The one rule worth enforcing here: an admin cannot demote themselves. It is
   * not paranoia about malice, it is that a single-admin install locked out of
   * its own admin panel needs a database console to recover.
   */
  async setRole(actorId: string, userId: string, role: Role): Promise<void> {
    if (actorId === userId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id: userId }, data: { role } });
  }

  /** Platform-wide numbers for the admin dashboard. */
  async stats() {
    const [users, courses, published, enrollments, certificates, assets, jobs] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.course.count(),
      this.prisma.course.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.enrollment.count({ where: { status: { in: ['ACTIVE', 'COMPLETED'] } } }),
      this.prisma.certificate.count(),
      this.prisma.videoAsset.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.transcodeJob.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    return {
      users,
      courses,
      publishedCourses: published,
      enrollments,
      certificates,
      videoAssets: Object.fromEntries(assets.map((row) => [row.status, row._count._all])),
      transcodeJobs: Object.fromEntries(jobs.map((row) => [row.status, row._count._all])),
    };
  }
}
