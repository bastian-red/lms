import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = loadConfig();

  // Behind a reverse proxy the socket address is the proxy, not the client.
  // Trusting the first hop is what makes req.ip the address the rate limiter
  // should actually be counting.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Validation is Zod, in the controllers, against the shared contracts. No
  // Nest ValidationPipe and no class-validator: one definition of each shape.
  app.enableCors({ origin: config.appBaseUrl, credentials: true });
  app.enableShutdownHooks();

  // 0.0.0.0 rather than localhost: a container that binds the loopback answers
  // nothing from outside itself, so the compose healthcheck never passes.
  await app.listen(config.port, '0.0.0.0');
  Logger.log(`API listening on :${config.port} (media root: ${config.media.root})`, 'Bootstrap');
}

void bootstrap();
