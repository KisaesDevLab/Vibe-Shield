import {
  customType,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_token_index — dedup lookup: ``(session_id, hash) → token``.
 *
 * The same data could be derived from ``vs_tokens`` via a SELECT, but
 * BUILD_PLAN §5 explicitly names this as its own table for cheap
 * deduplication in the hot allocate-or-reuse path.
 */
export const tokenIndex = pgTable(
  'vs_token_index',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    hash: bytea('hash').notNull(),
    token: text('token').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.hash] })],
);

export type TokenIndexRow = typeof tokenIndex.$inferSelect;
export type NewTokenIndexRow = typeof tokenIndex.$inferInsert;
