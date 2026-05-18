import { customType, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_magic_links — short-lived one-time tokens.
 *
 * Cleartext token returned to the user in the magic-link email exactly
 * once. ``token_hash = SHA-256(cleartext)``. Consuming a link deletes
 * its row, so re-use is impossible. Default TTL: 15 minutes.
 */
export const magicLinks = pgTable(
  'vs_magic_links',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    requestedIp: text('requested_ip'),
  },
  (table) => [index('vs_magic_links_email_idx').on(table.email)],
);

export type MagicLinkRow = typeof magicLinks.$inferSelect;
