import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * vs_policies — versioned redaction / re-identification policy.
 * BUILD_PLAN §10 requires that any policy change creates a new version;
 * old versions are retained for audit. The unique ``(name, version)``
 * constraint enforces append-only semantics at the schema level.
 */
export const policies = pgTable(
  'vs_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    jsonConfig: jsonb('json_config').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('vs_policies_name_version_uq').on(table.name, table.version)],
);

export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
