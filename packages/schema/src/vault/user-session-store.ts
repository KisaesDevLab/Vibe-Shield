/**
 * UserSessionStore — Phase 24 magic-link-issued session tokens.
 *
 * Same hash-store pattern as ApiKeyStore + MagicLinkStore: cleartext
 * returned exactly once (delivered via HttpOnly cookie); SHA-256(cleartext)
 * is what lives in the DB.
 *
 * Sliding TTL: ``validate`` bumps ``last_seen_at`` and re-extends
 * ``expires_at`` so an active user stays logged in. Idle users expire
 * after ``idleTtlMinutes`` (default 24h).
 *
 * ``revoke`` is the explicit logout path. We could DELETE the row but
 * keep it as a tombstone (revoked_at IS NOT NULL) so audit can prove
 * which session ended and when.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { userSessions } from '../schema/user-sessions.js';

const TOKEN_BYTES = 32;
const DEFAULT_IDLE_TTL_MINUTES = 24 * 60;

export class SessionInvalidError extends Error {
  override readonly name = 'SessionInvalidError';
}

export interface IssuedSession {
  /** Cleartext session token; goes into the HttpOnly cookie. */
  token: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  userId: string;
  expiresAt: Date;
}

export class UserSessionStore {
  constructor(
    private readonly db: Database,
    private readonly idleTtlMinutes: number = DEFAULT_IDLE_TTL_MINUTES,
  ) {}

  /** Issue a new session for ``userId``. */
  async issue(userId: string, userAgent: string | null = null): Promise<IssuedSession> {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.idleTtlMinutes * 60_000);
    await this.db.insert(userSessions).values({
      tokenHash,
      userId,
      expiresAt,
      ...(userAgent !== null ? { userAgent } : {}),
    });
    return { token, expiresAt };
  }

  /**
   * Validate a presented cleartext session token. On success, slides
   * the TTL (last_seen_at = now, expires_at = now + idle). Throws
   * ``SessionInvalidError`` on missing, expired, or revoked sessions.
   */
  async validate(token: string): Promise<ResolvedSession> {
    const tokenHash = hashSessionToken(token);
    const now = new Date();
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          gt(userSessions.expiresAt, now),
          isNull(userSessions.revokedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SessionInvalidError('session invalid or expired');
    }
    const nextExpires = new Date(now.getTime() + this.idleTtlMinutes * 60_000);
    await this.db
      .update(userSessions)
      .set({ lastSeenAt: now, expiresAt: nextExpires })
      .where(eq(userSessions.tokenHash, tokenHash));
    return { userId: row.userId, expiresAt: nextExpires };
  }

  async revoke(token: string): Promise<void> {
    const tokenHash = hashSessionToken(token);
    await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.tokenHash, tokenHash));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  }
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
