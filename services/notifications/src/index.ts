import { logChannel, neverThrows, smtpChannel } from './channel';
import type { Channel } from './types';

export * from './channel';
export * from './templates';
export * from './types';

export interface NotificationsConfig {
  smtpHost?: string;
  smtpPort: number;
  smtpUser?: string;
  smtpPassword?: string;
  from: string;
}

export function notificationsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NotificationsConfig {
  const port = Number(env.SMTP_PORT);
  return {
    // Empty means "not configured", not "connect to the empty host".
    smtpHost: env.SMTP_HOST?.trim() || undefined,
    smtpPort: Number.isFinite(port) && port > 0 ? port : 1025,
    smtpUser: env.SMTP_USER?.trim() || undefined,
    smtpPassword: env.SMTP_PASSWORD,
    from: env.MAIL_FROM ?? 'lms@localhost',
  };
}

export function createChannel(config: NotificationsConfig): Channel {
  if (!config.smtpHost) return neverThrows(logChannel());
  return neverThrows(
    smtpChannel({
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      password: config.smtpPassword,
      from: config.from,
    }),
  );
}
