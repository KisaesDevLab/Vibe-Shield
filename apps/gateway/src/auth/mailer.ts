/**
 * Magic-link mailer — Phase 24.
 *
 * Wraps nodemailer with our minimal config surface. When SMTP_HOST is
 * unset, ``isEnabled`` returns false and ``send`` throws — the auth
 * route checks this and surfaces a clean 503.
 *
 * No HTML email. Plaintext only, single URL. Two reasons:
 *   1. Plaintext renders in every client; no spam-filter HTML traps.
 *   2. Smaller attack surface — no embedded resources, no fonts, no
 *      tracking pixels. Magic-link emails should be boring.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';

export interface MailerOptions {
  host: string;
  port: number;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
  tls: boolean;
  logger: Logger;
}

export class MailerDisabledError extends Error {
  override readonly name = 'MailerDisabledError';
}

export class Mailer {
  private readonly transporter: Transporter;

  constructor(private readonly opts: MailerOptions) {
    const auth =
      opts.user !== undefined && opts.password !== undefined
        ? { user: opts.user, pass: opts.password }
        : undefined;
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      // Force STARTTLS on the standard submission port; bypass for
      // tests / dev relays via SMTP_TLS=false.
      secure: opts.port === 465,
      requireTLS: opts.tls && opts.port !== 465,
      ...(auth !== undefined ? { auth } : {}),
    });
  }

  async sendMagicLink(opts: {
    to: string;
    url: string;
    expiresAt: Date;
  }): Promise<void> {
    const minutesUntilExpiry = Math.round(
      (opts.expiresAt.getTime() - Date.now()) / 60_000,
    );
    const body = [
      'A sign-in link was requested for your Vibe Shield admin account.',
      '',
      `Click here to sign in (expires in ${minutesUntilExpiry.toString()} minutes):`,
      opts.url,
      '',
      "If you didn't request this, you can ignore this email — the link",
      'can only be used once and expires shortly.',
      '',
      '— Vibe Shield',
    ].join('\n');
    try {
      await this.transporter.sendMail({
        from: this.opts.from,
        to: opts.to,
        subject: 'Sign in to Vibe Shield',
        text: body,
      });
    } catch (err) {
      // Don't include the URL in the error log — the URL contains the
      // cleartext token. Status + destination only.
      this.opts.logger.warn(
        {
          to_domain: opts.to.split('@')[1] ?? '?',
          error_class: err instanceof Error ? err.name : 'Unknown',
        },
        'magic-link email send failed',
      );
      throw err;
    }
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }
}
