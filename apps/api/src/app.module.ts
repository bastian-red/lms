import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard, OptionalAuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { RolesGuard } from './auth/roles.guard';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { CertificatesController } from './certificates/certificates.controller';
import { CertificatesService } from './certificates/certificates.service';
import { CONFIG, RATE_LIMITS, type AppConfig } from './config/config';
import { CoreModule } from './core/core.module';
import { EnrollmentService } from './enrollment/enrollment.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { InstructorController } from './instructor/instructor.controller';
import { InstructorService } from './instructor/instructor.service';
import { LearningService } from './learning/learning.service';
import { MediaController } from './media/media.controller';
import { MediaAccessService } from './media/media-access.service';
import { ManifestAuthGuard } from './media/manifest-auth.guard';
import { RedisService } from './redis/redis.service';

@Module({
  imports: [
    CoreModule,
    // Rate limiting is backed by Redis rather than by in-process memory, so the
    // budget is per client across every API instance instead of per instance.
    // With memory storage, running two containers doubles everyone's allowance.
    ThrottlerModule.forRootAsync({
      inject: [CONFIG, RedisService],
      useFactory: (config: AppConfig, redis: RedisService) => ({
        throttlers: [{ name: 'default', limit: config.rateLimits.global, ttl: 60_000 }],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    CatalogController,
    MediaController,
    CertificatesController,
    InstructorController,
    AdminController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    AuthService,
    CatalogService,
    EnrollmentService,
    LearningService,
    MediaAccessService,
    ManifestAuthGuard,
    CertificatesService,
    InstructorService,
    AdminService,
    HealthService,
  ],
})
export class AppModule {}

// Referenced so the constant is not tree-shaken out of the build; the
// @Throttle decorators read it at class-definition time.
void RATE_LIMITS;
