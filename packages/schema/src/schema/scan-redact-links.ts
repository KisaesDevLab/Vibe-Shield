import {
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { redactJobs } from './redact-jobs.js';
import { scanFiles, scanJobs } from './scan-jobs.js';

/**
 * vs_scan_redact_links — Phase 26 v1.9.
 *
 * One row per (scan_file → redact_job) created by the bulk-redact
 * endpoint. The same scan_file can be redacted twice; the unique
 * index is on (scan_file_id, redact_job_id) not scan_file_id alone.
 */
export const scanRedactLinks = pgTable(
  'vs_scan_redact_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanJobId: uuid('scan_job_id')
      .notNull()
      .references(() => scanJobs.id, { onDelete: 'cascade' }),
    scanFileId: uuid('scan_file_id')
      .notNull()
      .references(() => scanFiles.id, { onDelete: 'cascade' }),
    redactJobId: uuid('redact_job_id')
      .notNull()
      .references(() => redactJobs.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_scan_redact_links_scan_idx').on(table.scanJobId),
    index('vs_scan_redact_links_redact_idx').on(table.redactJobId),
    unique('vs_scan_redact_links_unique').on(
      table.scanFileId,
      table.redactJobId,
    ),
  ],
);

export type ScanRedactLinkRow = typeof scanRedactLinks.$inferSelect;
export type NewScanRedactLinkRow = typeof scanRedactLinks.$inferInsert;
