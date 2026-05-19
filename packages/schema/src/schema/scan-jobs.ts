import {
  bigint,
  boolean,
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
 * vs_scan_jobs — Phase 26 (v1.8 foundation).
 *
 * One row per user-initiated scan of a file or zip archive. The
 * engine streams findings back over NDJSON and the gateway pipeline
 * persists them into vs_scan_files + vs_scan_findings as they land.
 *
 * State machine: pending → running → (completed | failed). Same
 * pattern as vs_redact_jobs.
 */
export const scanJobs = pgTable(
  'vs_scan_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** ``file|archive`` — single uploaded file vs. zip with many. */
    sourceKind: text('source_kind').notNull(),
    sourceName: text('source_name').notNull(),
    sourceMime: text('source_mime').notNull(),
    sourceSizeBytes: bigint('source_size_bytes', { mode: 'number' }).notNull(),
    filesCount: integer('files_count').notNull().default(0),
    findingsCount: integer('findings_count').notNull().default(0),
    findingsHigh: integer('findings_high').notNull().default(0),
    findingsMedium: integer('findings_medium').notNull().default(0),
    findingsLow: integer('findings_low').notNull().default(0),
    /** ``pending|running|completed|failed``. */
    status: text('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '90 days'`),
  },
  (table) => [
    index('vs_scan_jobs_user_idx').on(table.userId, table.createdAt),
  ],
);

export const scanFiles = pgTable(
  'vs_scan_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => scanJobs.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    /** Non-null = the engine couldn't scan it (encrypted / unsupported / too big). */
    skippedReason: text('skipped_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('vs_scan_files_job_idx').on(table.jobId)],
);

export const scanFindings = pgTable(
  'vs_scan_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => scanJobs.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => scanFiles.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    /** ``low|medium|high``. */
    severity: text('severity').notNull(),
    /** Scanner-specific location string — see migration comment. */
    location: text('location').notNull(),
    /** Context window with the entity replaced by `<ENTITY_TYPE>`. */
    snippetRedacted: text('snippet_redacted').notNull(),
    /** SHA-256(cleartext) — dedupe + audit without storing PII. */
    sampleHash: text('sample_hash').notNull(),
    suppressed: boolean('suppressed').notNull().default(false),
    /** v1.9 — actor who suppressed, timestamp, optional reason. */
    suppressedBy: uuid('suppressed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }),
    suppressedReason: text('suppressed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_scan_findings_job_idx').on(table.jobId, table.severity),
    index('vs_scan_findings_file_idx').on(table.fileId),
  ],
);

export type ScanJobRow = typeof scanJobs.$inferSelect;
export type NewScanJobRow = typeof scanJobs.$inferInsert;
export type ScanFileRow = typeof scanFiles.$inferSelect;
export type NewScanFileRow = typeof scanFiles.$inferInsert;
export type ScanFindingRow = typeof scanFindings.$inferSelect;
export type NewScanFindingRow = typeof scanFindings.$inferInsert;
