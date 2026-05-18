/**
 * RedactJobStore — Phase D + Phase 17 v1.4.
 *
 * Owns the state machine for user-initiated document redactions.
 * Artifacts live on disk; this store carries only the metadata + the
 * pending → running → (completed | failed) transitions.
 *
 * The caller is responsible for filesystem layout — see
 * ``apps/gateway/src/redact/storage.ts`` for the
 * ``/var/lib/vibe-shield/redact/jobs/<id>/`` directory contract.
 */

import { and, desc, eq, isNull, lt, lte, or } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { redactJobs } from '../schema/redact-jobs.js';

export type RedactJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RedactJobRecord {
  id: string;
  userId: string;
  filename: string;
  mime: string;
  sourceSizeBytes: number;
  pagesCount: number | null;
  status: RedactJobStatus;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateRedactJobInput {
  userId: string;
  filename: string;
  mime: string;
  sourceSizeBytes: number;
}

export class RedactJobNotFoundError extends Error {
  override readonly name = 'RedactJobNotFoundError';
}

export class RedactJobStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateRedactJobInput): Promise<RedactJobRecord> {
    const [row] = await this.db
      .insert(redactJobs)
      .values({
        userId: input.userId,
        filename: input.filename,
        mime: input.mime,
        sourceSizeBytes: input.sourceSizeBytes,
      })
      .returning();
    if (row === undefined) {
      throw new Error('insert returned no rows');
    }
    return toRecord(row);
  }

  async findById(id: string): Promise<RedactJobRecord | null> {
    const rows = await this.db
      .select()
      .from(redactJobs)
      .where(eq(redactJobs.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Recent jobs for one user, newest first. The Redact SPA history
   * view consumes this. ``limit`` capped at 200 to bound DB load.
   */
  async listForUser(userId: string, limit = 50): Promise<RedactJobRecord[]> {
    const cap = Math.min(Math.max(limit, 1), 200);
    const rows = await this.db
      .select()
      .from(redactJobs)
      .where(eq(redactJobs.userId, userId))
      .orderBy(desc(redactJobs.createdAt))
      .limit(cap);
    return rows.map(toRecord);
  }

  /** Admin variant: list across all users (used by the admin audit view). */
  async listAll(limit = 50): Promise<RedactJobRecord[]> {
    const cap = Math.min(Math.max(limit, 1), 200);
    const rows = await this.db
      .select()
      .from(redactJobs)
      .orderBy(desc(redactJobs.createdAt))
      .limit(cap);
    return rows.map(toRecord);
  }

  /** Mark the job as running (worker picked it up). */
  async markRunning(id: string, pagesCount: number): Promise<void> {
    await this.db
      .update(redactJobs)
      .set({
        status: 'running',
        pagesCount,
        startedAt: new Date(),
      })
      .where(eq(redactJobs.id, id));
  }

  async markCompleted(id: string): Promise<void> {
    await this.db
      .update(redactJobs)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(redactJobs.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(redactJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: errorMessage.slice(0, 1000),
      })
      .where(eq(redactJobs.id, id));
  }

  /** Find completed jobs past their expiry — for the artifact-purge cron. */
  async findExpired(now: Date = new Date()): Promise<RedactJobRecord[]> {
    const rows = await this.db
      .select()
      .from(redactJobs)
      .where(
        and(eq(redactJobs.status, 'completed'), lte(redactJobs.expiresAt, now)),
      )
      .limit(100);
    return rows.map(toRecord);
  }

  /**
   * Delete the row after the disk artifacts have been removed. We
   * keep failed rows for diagnosis until manual cleanup.
   */
  async delete(id: string): Promise<void> {
    await this.db.delete(redactJobs).where(eq(redactJobs.id, id));
  }

  /**
   * Recover orphaned jobs: anything that was running when the
   * gateway crashed. The worker calls this at startup and marks them
   * failed so the user can re-upload.
   */
  async reapStaleRunning(stuckSinceSeconds = 600): Promise<number> {
    const cutoff = new Date(Date.now() - stuckSinceSeconds * 1000);
    const result = await this.db
      .update(redactJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: 'gateway restarted while job was running',
      })
      .where(
        and(
          eq(redactJobs.status, 'running'),
          or(isNull(redactJobs.startedAt), lt(redactJobs.startedAt, cutoff)),
        ),
      )
      .returning({ id: redactJobs.id });
    return result.length;
  }
}

function toRecord(row: typeof redactJobs.$inferSelect): RedactJobRecord {
  return {
    id: row.id,
    userId: row.userId,
    filename: row.filename,
    mime: row.mime,
    sourceSizeBytes: row.sourceSizeBytes,
    pagesCount: row.pagesCount,
    status: row.status as RedactJobStatus,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
