import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { setRoleSchema, type SetRoleInput } from '@lms/shared';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser, type CurrentUserInfo } from '../auth/current-user.decorator';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminService } from './admin.service';

@UseGuards(AuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('users')
  users() {
    return this.admin.users();
  }

  @Post('users/:userId/role')
  async setRole(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(setRoleSchema)) body: SetRoleInput,
    @CurrentUser() actor: CurrentUserInfo,
  ): Promise<{ ok: true }> {
    await this.admin.setRole(actor.id, userId, body.role);
    return { ok: true };
  }
}
