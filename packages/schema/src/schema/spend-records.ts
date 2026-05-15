import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * vs_spend_records — one row per Anthropic call.
 *
 * Used to enforce per-tenant monthly spend caps (Phase 8b) and to feed
 * Phase 19's Prometheus spend metrics. Token counts are recorded
 * separately so we can re-price retroactively if Anthropic's per-token
 * pricing changes.
 */
export const spendRecords = pgTable(
  'vs_spend_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    appId: text('app_id').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** Cost in micro-dollars (USD * 1e6) so we never use float for money. */
    costMicrodollars: numeric('cost_microdollars', { precision: 18, scale: 0 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_spend_records_tenant_created_idx').on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export type SpendRecord = typeof spendRecords.$inferSelect;
export type NewSpendRecord = typeof spendRecords.$inferInsert;
