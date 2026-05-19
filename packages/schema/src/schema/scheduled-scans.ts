import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { scanJobs } from './scan-jobs.js';
import { users } from './users.js';

/**
 * vs_scheduled_scans — Phase 26 v1.9.
 *
 * A scheduled scan re-runs against a "source ref" on a cadence.
 * The gateway scheduler polls this table every minute, picks rows
 * whose ``next_run_at`` has elapsed, fires a scan, and updates
 * ``last_run_*`` + recomputes ``next_run_at`` from the cron expr.
 *
 * v1.9 supports ``source_kind = 'filesystem'`` only. The
 * ``source_ref`` is an absolute path on the appliance volume; the
 * scheduler validates it lives under ``SCHEDULED_SCAN_ROOT`` (env)
 * before walking. Future kinds: ``imap``, ``s3``, ``smb`` —
 * scoped out of v1.9.
 */
export const scheduledScans = pgTable(
  'vs_scheduled_scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceRef: text('source_ref').notNull(),
    /** Standard 5-field cron expression, UTC. */
    cronExpression: text('cron_expression').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunJobId: uuid('last_run_job_id').references(() => scanJobs.id, {
      onDelete: 'set null',
    }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** Comma-separated email list. NULL = no email alerts. */
    notifyEmails: text('notify_emails'),
    webhookUrl: text('webhook_url'),
    webhookSecret: text('webhook_secret'),
    /** ``low|medium|high`` — only alert on findings >= this. */
    alertMinSeverity: text('alert_min_severity').notNull().default('high'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_scheduled_scans_user_idx').on(table.userId),
    index('vs_scheduled_scans_next_run_idx').on(table.nextRunAt),
  ],
);

export type ScheduledScanRow = typeof scheduledScans.$inferSelect;
export type NewScheduledScanRow = typeof scheduledScans.$inferInsert;
