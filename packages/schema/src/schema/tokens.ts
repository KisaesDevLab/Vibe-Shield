import {
  customType,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';

/**
 * Drizzle's ``bytea`` reads cleanly as Node Buffer through pg-native's
 * binary mode. We provide an explicit custom type so callers never get a
 * silent string/Buffer mismatch.
 */
const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_tokens — the encrypted token vault.
 *
 * - ``cleartext_encrypted`` is ``nonce || ciphertext || tag`` produced by
 *   AES-256-GCM under the session tenant's DEK (see src/crypto/aead.ts).
 * - ``hash`` is HMAC-SHA-256 keyed by the DEK, scoped to ``session_id`` so
 *   dedup is per-session and so the same cleartext maps to different
 *   hashes across tenants (a per-tenant DEK guarantees this).
 */
export const tokens = pgTable(
  'vs_tokens',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    entityType: text('entity_type').notNull(),
    cleartextEncrypted: bytea('cleartext_encrypted').notNull(),
    hash: bytea('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.token] })],
);

export type TokenRow = typeof tokens.$inferSelect;
export type NewTokenRow = typeof tokens.$inferInsert;
