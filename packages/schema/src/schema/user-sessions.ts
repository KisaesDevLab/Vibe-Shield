import { customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_user_sessions — magic-link-issued session tokens.
 *
 * ``token_hash = SHA-256(cleartext)``. Cleartext lives only in the
 * client's HttpOnly cookie. Sliding TTL: ``expires_at`` is recomputed
 * as ``last_seen_at + idle_ttl`` on every request that resolves the
 * session. ``revoked_at`` is set when the user explicitly logs out or
 * an admin invalidates the session.
 */
export const userSessions = pgTable(
  'vs_user_sessions',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('vs_user_sessions_user_idx').on(table.userId)],
);

export type UserSessionRow = typeof userSessions.$inferSelect;
