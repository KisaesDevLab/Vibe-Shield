import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * vs_redact_jobs — Phase D + Phase 17 v1.4.
 *
 * One row per user-initiated document redaction. The DB carries the
 * metadata + state machine; the actual bytes live on disk under
 * ``/var/lib/vibe-shield/redact/jobs/<id>/``.
 *
 * State machine: pending → running → (completed | failed). Workers
 * transition rows via ``RedactJobStore.setStatus``. Completed jobs
 * auto-expire 30 days after creation; the artifact-purge cron walks
 * ``vs_redact_jobs_expiry_idx`` and deletes the on-disk directory
 * plus the row.
 */
export const redactJobs = pgTable(
  'vs_redact_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sourceSizeBytes: bigint('source_size_bytes', { mode: 'number' }).notNull(),
    pagesCount: integer('pages_count'),
    /** ``pending|running|completed|failed`` (CHECK in migration). */
    status: text('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
  },
  (table) => [
    index('vs_redact_jobs_user_idx').on(table.userId, table.createdAt),
  ],
);

export type RedactJobRow = typeof redactJobs.$inferSelect;
export type NewRedactJobRow = typeof redactJobs.$inferInsert;
