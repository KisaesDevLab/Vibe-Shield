/**
 * Session lifecycle.
 *
 * BUILD_PLAN §6: sessions group requests so cleartext within a session
 * tokenizes to the same value, and cross-session tokenization is
 * deliberately uncorrelated (so Anthropic cannot stitch sessions
 * together). Sessions auto-expire after a configurable idle window
 * (default 60 minutes); a periodic GC purges expired sessions, which
 * cascade-deletes the associated tokens.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { sessions } from '../schema/sessions.js';
import type { Database } from '../db/index.js';

export interface CreateSessionInput {
  tenantId: string;
  appId: string;
  userId: string;
  /** Idle window in minutes. Default 60 per BUILD_PLAN §6. */
  ttlMinutes?: number;
  policyId?: string;
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  appId: string;
  userId: string;
  policyId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export class SessionExpiredError extends Error {
  override readonly name = 'SessionExpiredError';
}

export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError';
}

const DEFAULT_TTL_MINUTES = 60;

export class SessionManager {
  constructor(private readonly db: Database) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const ttl = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60_000);
    const [row] = await this.db
      .insert(sessions)
      .values({
        tenantId: input.tenantId,
        appId: input.appId,
        userId: input.userId,
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        expiresAt,
      })
      .returning();
    if (row === undefined) {
      throw new Error('insert returned no rows');
    }
    return toRecord(row);
  }

  /**
   * Fetch a session if it exists and has not expired. Returns ``null``
   * for missing; throws ``SessionExpiredError`` for present-but-expired
   * (callers usually want to distinguish the two).
   */
  async get(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new SessionExpiredError(`session ${id} expired at ${row.expiresAt.toISOString()}`);
    }
    return toRecord(row);
  }

  /**
   * Bump the expiry forward. Called by the gateway on each request that
   * uses the session (idle-window semantics).
   */
  async touch(id: string, ttlMinutes: number = DEFAULT_TTL_MINUTES): Promise<SessionRecord> {
    const newExpiry = new Date(Date.now() + ttlMinutes * 60_000);
    const [row] = await this.db
      .update(sessions)
      .set({ expiresAt: newExpiry })
      .where(eq(sessions.id, id))
      .returning();
    if (row === undefined) {
      throw new SessionNotFoundError(`session ${id} not found`);
    }
    return toRecord(row);
  }

  /** Hard delete one session (cascades to vs_tokens / vs_token_index). */
  async delete(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  /**
   * GC job: delete every session whose ``expires_at`` is in the past.
   * Returns the number of sessions purged. Cascading FK on
   * ``vs_tokens`` / ``vs_token_index`` removes the corresponding token
   * material in the same transaction.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    return result.length;
  }

  /** Count active (non-expired) sessions for a tenant. Diagnostics only. */
  async countActive(tenantId: string, now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.tenantId, tenantId), gt(sessions.expiresAt, now)));
    return rows[0]?.n ?? 0;
  }
}

function toRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    appId: row.appId,
    userId: row.userId,
    policyId: row.policyId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
