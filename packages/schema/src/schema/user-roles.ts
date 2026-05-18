import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * vs_user_roles — per-module RBAC.
 *
 * Per UI-Build-Addendum §4.3 a user has independent roles across
 * Module 1 (Redact), Module 2 (Scan), Module 3 (Compliance). A user
 * without a row for a given module has no access to it. ``is_org_admin``
 * on vs_users bypasses this table.
 */
export const userRoles = pgTable(
  'vs_user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ``redact`` | ``scan`` | ``compliance`` — CHECK in migration. */
    module: text('module').notNull(),
    /** ``viewer`` | ``operator`` | ``admin`` — CHECK in migration. */
    role: text('role').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.module] }),
  ],
);

export type UserRoleRow = typeof userRoles.$inferSelect;
export type NewUserRoleRow = typeof userRoles.$inferInsert;
