import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * vs_redact_batches — v1.6 bulk-redact.
 *
 * A batch is a user-initiated multi-file upload; each file becomes
 * one row in ``vs_redact_jobs`` linked back via ``batch_id``.
 * Batch-less jobs (single-file uploads) keep ``batch_id = NULL``.
 */
export const redactBatches = pgTable(
  'vs_redact_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name'),
    totalJobs: integer('total_jobs').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('vs_redact_batches_user_idx').on(table.userId, table.createdAt)],
);

export type RedactBatchRow = typeof redactBatches.$inferSelect;
