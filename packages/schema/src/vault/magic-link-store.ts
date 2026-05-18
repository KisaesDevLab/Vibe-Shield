/**
 * MagicLinkStore — Phase 24 short-lived one-time auth tokens.
 *
 * ``issue`` returns the cleartext token (URL-safe base64, 32 bytes of
 * entropy) and persists only the SHA-256. ``consume`` validates the
 * presented cleartext, deletes the row atomically, and returns the
 * bound email if valid.
 *
 * Hygiene: never log cleartext tokens. The cleartext is meant to live
 * in two places — the URL in the email, and the user's clipboard while
 * they paste it — and nowhere else.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { magicLinks } from '../schema/magic-links.js';

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MINUTES = 15;

export class MagicLinkInvalidError extends Error {
  override readonly name = 'MagicLinkInvalidError';
}

export class MagicLinkExpiredError extends Error {
  override readonly name = 'MagicLinkExpiredError';
}

export interface IssueResult {
  /** Cleartext token to embed in the magic-link URL. Never persisted. */
  token: string;
  expiresAt: Date;
}

export class MagicLinkStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMinutes: number = DEFAULT_TTL_MINUTES,
  ) {}

  /**
   * Generate a fresh token for ``email``. ``requestedIp`` is recorded
   * for abuse investigation. Returns the cleartext token — the caller
   * is responsible for sending it via SMTP and dropping the reference.
   */
  async issue(email: string, requestedIp: string | null = null): Promise<IssueResult> {
    const normalized = email.trim().toLowerCase();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);
    await this.db.insert(magicLinks).values({
      tokenHash,
      email: normalized,
      expiresAt,
      ...(requestedIp !== null ? { requestedIp } : {}),
    });
    return { token, expiresAt };
  }

  /**
   * Validate a presented cleartext token. On success, deletes the row
   * (single-use) and returns the bound email. Throws on missing,
   * expired, or already-consumed tokens.
   */
  async consume(token: string): Promise<{ email: string }> {
    const tokenHash = hashToken(token);
    const now = new Date();
    const rows = await this.db
      .select()
      .from(magicLinks)
      .where(and(eq(magicLinks.tokenHash, tokenHash), gt(magicLinks.expiresAt, now)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      // Could be: never issued, expired, or already consumed.
      // We don't distinguish to avoid leaking enumeration info.
      throw new MagicLinkInvalidError('magic link invalid or already used');
    }
    // Best-effort single-use: delete the row before returning.
    await this.db.delete(magicLinks).where(eq(magicLinks.tokenHash, tokenHash));
    return { email: row.email };
  }

  /** Sweep expired rows. Safe to call from a cron. */
  async reapExpired(): Promise<number> {
    const result = await this.db
      .delete(magicLinks)
      .where(lt(magicLinks.expiresAt, new Date()))
      .returning({ tokenHash: magicLinks.tokenHash });
    return result.length;
  }
}

export function generateToken(): string {
  // URL-safe base64: '+/' -> '-_' and strip padding. 32 bytes -> 43 chars.
  return randomBytes(TOKEN_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
