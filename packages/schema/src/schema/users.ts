import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * vs_users — Phase 24 identity v2.
 *
 * One row per appliance operator. ``is_org_admin`` bypasses every
 * per-module RBAC check. ``disabled_at`` is the soft-delete: a
 * disabled user can't authenticate but the row stays for audit.
 *
 * Email uniqueness is enforced case-insensitively by the partial
 * unique index in migration 0005 (LOWER(email) where disabled_at IS
 * NULL). That means an email can be re-used after the previous owner
 * is disabled — handled at the application layer.
 */
export const users = pgTable('vs_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  isOrgAdmin: boolean('is_org_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
