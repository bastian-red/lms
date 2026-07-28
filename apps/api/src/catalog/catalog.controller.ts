import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type {
  CourseDetail,
  CourseSummary,
  EnrollmentSummary,
  HeartbeatResult,
  LessonPlayback,
  QuizAttemptResult,
  QuizSubmissionInput,
} from '@lms/shared';
import { heartbeatSchema, quizSubmissionSchema } from '@lms/shared';
import { AuthGuard, OptionalAuthGuard } from '../auth/auth.guard';
import { CurrentUser, type CurrentUserInfo } from '../auth/current-user.decorator';
import type { AuthedRequest } from '../auth/auth.guard';
import { Req } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { LearningService } from '../learning/learning.service';
import { CatalogService } from './catalog.service';

/** Public catalogue plus the signed-in student's own view of it. */
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly enrollment: EnrollmentService,
    private readonly learning: LearningService,
  ) {}

  @Get('courses')
  list(): Promise<CourseSummary[]> {
    return this.catalog.listPublished();
  }

  /**
   * A course page.
   *
   * Optional auth, because the page is public but shows more when signed in.
   * The alternative — two endpoints, or an unauthenticated call plus a second
   * one for progress — would mean the page renders in two stages and flickers.
   */
  @UseGuards(OptionalAuthGuard)
  @Get('courses/:slug')
  detail(@Param('slug') slug: string, @Req() request: AuthedRequest): Promise<CourseDetail> {
    return this.catalog.detail(slug, request.user?.id);
  }

  @UseGuards(AuthGuard)
  @Get('me/courses')
  myCourses(@CurrentUser() user: CurrentUserInfo) {
    return this.catalog.myCourses(user.id);
  }

  @UseGuards(AuthGuard)
  @Post('courses/:courseId/enroll')
  enroll(
    @Param('courseId') courseId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<EnrollmentSummary> {
    return this.enrollment.enroll(user.id, courseId);
  }

  @UseGuards(AuthGuard)
  @Get('lessons/:lessonId/playback')
  playback(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<LessonPlayback> {
    return this.learning.playback(user.id, lessonId);
  }

  /**
   * The watch heartbeat.
   *
   * Posted every few seconds by the player with the ranges covered since the
   * last beat. The server merges, clamps against wall-clock, and decides
   * completion; the client's opinion about any of that is not consulted.
   */
  @UseGuards(AuthGuard)
  @Post('lessons/:lessonId/progress')
  progress(
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(heartbeatSchema)) body: { intervals: { start: number; end: number }[] },
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<HeartbeatResult> {
    return this.learning.heartbeat(user.id, lessonId, body.intervals);
  }

  @UseGuards(AuthGuard)
  @Post('lessons/:lessonId/quiz')
  submitQuiz(
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(quizSubmissionSchema)) body: QuizSubmissionInput,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<QuizAttemptResult> {
    return this.learning.submitQuiz(user.id, lessonId, body);
  }
}
