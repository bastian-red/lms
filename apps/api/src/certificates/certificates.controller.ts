import { Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { CertificateSummary, CertificateVerification } from '@lms/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser, type CurrentUserInfo } from '../auth/current-user.decorator';
import { CertificatesService } from './certificates.service';

@Controller()
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  /**
   * Issue, or return the one already issued.
   *
   * A POST that is safe to repeat: the unique index on the enrollment means the
   * second caller reads back the first's row rather than minting a second
   * serial.
   */
  @UseGuards(AuthGuard)
  @Post('courses/:courseId/certificate')
  issue(
    @Param('courseId') courseId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<CertificateSummary> {
    return this.certificates.issue(user.id, courseId);
  }

  @UseGuards(AuthGuard)
  @Get('courses/:courseId/certificate')
  mine(
    @Param('courseId') courseId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<CertificateSummary | null> {
    return this.certificates.forEnrollment(user.id, courseId);
  }

  /** What is still standing between this student and a certificate. */
  @UseGuards(AuthGuard)
  @Get('courses/:courseId/certificate/eligibility')
  async eligibility(
    @Param('courseId') courseId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ eligible: boolean; outstanding: string[] }> {
    const outstanding = await this.certificates.outstandingLessons(user.id, courseId);
    return { eligible: outstanding.length === 0, outstanding: outstanding.map((l) => l.title) };
  }

  @UseGuards(AuthGuard)
  @Get('certificates/:serial/pdf')
  async pdf(
    @Param('serial') serial: string,
    @CurrentUser() user: CurrentUserInfo,
    @Res() response: Response,
  ): Promise<void> {
    const { bytes, filename } = await this.certificates.pdf(user.id, serial);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.send(bytes);
  }

  /**
   * Public verification. No auth: the whole point of a serial on a printed
   * certificate is that a stranger can check it.
   *
   * Rate limited harder than the global budget because it is the one endpoint
   * where guessing has a payoff. Combined with a 58-bit serial, brute force is
   * not on the table.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('verify/:serial')
  verify(@Param('serial') serial: string): Promise<CertificateVerification> {
    return this.certificates.verify(serial);
  }
}
