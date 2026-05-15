import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

/**
 * Sessions group requests so that the same cleartext within a session
 * collapses to the same token, while cross-session usage produces
 * different tokens (BUILD_PLAN §2.4 privacy property).
 */
export const sessions = pgTable(
  'vs_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    appId: text('app_id').notNull(),
    userId: text('user_id').notNull(),
    policyId: uuid('policy_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('vs_sessions_tenant_idx').on(table.tenantId),
    index('vs_sessions_expires_idx').on(table.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
