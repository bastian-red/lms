import { createTransport, type Transporter } from 'nodemailer';
import type { Channel, Message } from './types';

/**
 * Delivery channels.
 *
 * Two of them, chosen by whether SMTP_HOST is set. Locally that means Mailhog;
 * with the variable empty it means the log channel, which prints instead of
 * sending. A clone with no mail server configured must still run every flow end
 * to end, so "no SMTP" is a supported configuration rather than a crash.
 */

/** Prints the message. Never throws, which is the point. */
export function logChannel(): Channel {
  return {
    name: 'log',
    async send(message: Message): Promise<void> {
      console.warn(`[mail:log] to=${message.to} subject=${JSON.stringify(message.subject)}`);
      console.warn(message.text);
    },
  };
}

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
}

export function smtpChannel(options: SmtpOptions): Channel {
  const transport: Transporter = createTransport({
    host: options.host,
    port: options.port,
    // Mailhog speaks plain SMTP on 1025 and offers no STARTTLS. `secure` is
    // therefore off for the local port and on for the submission port, rather
    // than hardcoded either way.
    secure: options.port === 465,
    auth: options.user ? { user: options.user, pass: options.password ?? '' } : undefined,
    // Bounded so a dead mail host cannot hold a request open indefinitely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    name: 'smtp',
    async send(message: Message): Promise<void> {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

/**
 * Wrap a channel so a delivery failure is logged rather than thrown.
 *
 * A certificate is issued and a course is completed whether or not the
 * congratulation email reaches the student. Letting nodemailer's error escape
 * would turn a mail outage into a 500 on a request that already succeeded, and
 * the student would see a failure for work they actually finished.
 */
export function neverThrows(channel: Channel): Channel {
  return {
    name: `${channel.name}(safe)`,
    async send(message: Message): Promise<void> {
      try {
        await channel.send(message);
      } catch (error) {
        console.error(
          `[mail] delivery to ${message.to} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
