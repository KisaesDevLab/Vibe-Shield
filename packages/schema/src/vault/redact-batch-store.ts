/**
 * RedactBatchStore — v1.6 bulk-redact.
 *
 * A batch is a user-initiated multi-file upload. The batch row holds
 * metadata (user, optional display name, total job count); each file
 * gets its own ``vs_redact_jobs`` row linked back via ``batch_id``.
 *
 * Listing + per-batch aggregation are the read paths; the
 * ``RedactJobStore.listForBatch`` helper is the join side.
 */

import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { redactBatches } from '../schema/redact-batches.js';

export interface RedactBatchRecord {
  id: string;
  userId: string;
  name: string | null;
  totalJobs: number;
  createdAt: Date;
}

export interface CreateRedactBatchInput {
  userId: string;
  name?: string;
  totalJobs: number;
}

export class RedactBatchStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateRedactBatchInput): Promise<RedactBatchRecord> {
    const [row] = await this.db
      .insert(redactBatches)
      .values({
        userId: input.userId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        totalJobs: input.totalJobs,
      })
      .returning();
    if (row === undefined) {
      throw new Error('insert returned no rows');
    }
    return toRecord(row);
  }

  async findById(id: string): Promise<RedactBatchRecord | null> {
    const rows = await this.db
      .select()
      .from(redactBatches)
      .where(eq(redactBatches.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listForUser(userId: string, limit = 50): Promise<RedactBatchRecord[]> {
    const cap = Math.min(Math.max(limit, 1), 200);
    const rows = await this.db
      .select()
      .from(redactBatches)
      .where(eq(redactBatches.userId, userId))
      .orderBy(desc(redactBatches.createdAt))
      .limit(cap);
    return rows.map(toRecord);
  }
}

function toRecord(row: typeof redactBatches.$inferSelect): RedactBatchRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    totalJobs: row.totalJobs,
    createdAt: row.createdAt,
  };
}
