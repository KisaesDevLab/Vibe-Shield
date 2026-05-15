import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_api_keys — credentials Vibe apps present to the gateway.
 *
 * Key format: ``vs_live_<24 base62 chars>``. Only the SHA-256 of the
 * full key is stored — the cleartext is shown to the operator exactly
 * once at issuance. Lookup is O(1) by key_hash (PK).
 *
 * Not enumerated in BUILD_PLAN §5, but required by §7's "Auth: gateway
 * issues its own API keys to Vibe apps (`vs_live_…`)" item.
 */
export const apiKeys = pgTable(
  'vs_api_keys',
  {
    keyHash: bytea('key_hash').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    appId: text('app_id').notNull(),
    /** Human-readable label shown in the admin UI (Phase 13). */
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('vs_api_keys_tenant_idx').on(table.tenantId),
    index('vs_api_keys_app_idx').on(table.appId),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
