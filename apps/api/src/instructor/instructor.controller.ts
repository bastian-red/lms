import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  createCourseSchema,
  createLessonSchema,
  createModuleSchema,
  updateCourseSchema,
  upsertQuizSchema,
  type CreateCourseInput,
  type CreateLessonInput,
  type CreateModuleInput,
  type UpdateCourseInput,
  type UpsertQuizInput,
} from '@lms/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser, type CurrentUserInfo } from '../auth/current-user.decorator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CatalogService } from '../catalog/catalog.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { InstructorService } from './instructor.service';

/**
 * Authoring routes.
 *
 * Both guards, in this order: AuthGuard populates the user, RolesGuard checks
 * the role. The role is necessary but never sufficient — every service method
 * additionally verifies that this instructor owns this course.
 */
@UseGuards(AuthGuard, RolesGuard)
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('instructor')
export class InstructorController {
  constructor(
    private readonly instructor: InstructorService,
    private readonly catalog: CatalogService,
    private readonly enrollment: EnrollmentService,
  ) {}

  @Get('courses')
  myCourses(@CurrentUser() user: CurrentUserInfo) {
    return this.catalog.listForInstructor(user.id);
  }

  @Post('courses')
  createCourse(
    @Body(new ZodValidationPipe(createCourseSchema)) body: CreateCourseInput,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    return this.instructor.createCourse(user.id, body);
  }

  @Get('courses/:courseId')
  course(@Param('courseId') courseId: string, @CurrentUser() user: CurrentUserInfo) {
    return this.instructor.courseForEditing(user.id, courseId);
  }

  @Patch('courses/:courseId')
  updateCourse(
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(updateCourseSchema)) body: UpdateCourseInput,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    return this.instructor.updateCourse(user.id, courseId, body);
  }

  @Post('courses/:courseId/modules')
  addModule(
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(createModuleSchema)) body: CreateModuleInput,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    return this.instructor.addModule(user.id, courseId, body);
  }

  @Post('courses/:courseId/lessons')
  addLesson(
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(createLessonSchema)) body: CreateLessonInput,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    return this.instructor.addLesson(user.id, courseId, body);
  }

  /**
   * Video upload.
   *
   * Memory storage rather than a temp file: the media service owns every path
   * under MEDIA_ROOT, and letting multer write wherever it likes would put a
   * second, unvalidated path-construction site in the codebase. The size limit
   * is enforced by multer (fast, before the body is buffered) and again in the
   * service (authoritative, in case the interceptor is ever reconfigured).
   */
  @Post('lessons/:lessonId/video')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024), files: 1 },
    }),
  )
  uploadVideo(
    @Param('lessonId') lessonId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    if (!file) {
      return Promise.reject(new Error('No file was uploaded'));
    }
    return this.instructor.uploadVideo(user.id, lessonId, file);
  }

  @Post('lessons/:lessonId/quiz')
  upsertQuiz(
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(upsertQuizSchema)) body: UpsertQuizInput,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    return this.instructor.upsertQuiz(user.id, lessonId, body);
  }

  @Get('courses/:courseId/analytics')
  analytics(@Param('courseId') courseId: string, @CurrentUser() user: CurrentUserInfo) {
    return this.instructor.analytics(user.id, courseId);
  }

  @Get('courses/:courseId/roster')
  roster(@Param('courseId') courseId: string, @CurrentUser() user: CurrentUserInfo) {
    return this.enrollment.roster(user.id, user.role, courseId);
  }

  /**
   * Revoke a student mid-course.
   *
   * The demonstrable consequence: their next key fetch is refused, so playback
   * stops within one segment even though the ticket in their browser is still
   * valid for hours.
   */
  @Post('enrollments/:enrollmentId/revoke')
  async revoke(
    @Param('enrollmentId') enrollmentId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ ok: true }> {
    await this.enrollment.revoke(user.id, user.role, enrollmentId);
    return { ok: true };
  }

  @Post('enrollments/:enrollmentId/reinstate')
  async reinstate(
    @Param('enrollmentId') enrollmentId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<{ ok: true }> {
    await this.enrollment.reinstate(user.id, user.role, enrollmentId);
    return { ok: true };
  }
}
