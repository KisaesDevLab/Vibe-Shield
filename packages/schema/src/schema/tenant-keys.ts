import { customType, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_tenant_keys — wrapped per-tenant DEKs.
 *
 * BUILD_PLAN §5 says "Per-tenant DEK wrapped by an appliance-level KEK"
 * but does not enumerate this table explicitly. We add it here because
 * the alternative — HKDF-deriving the DEK from KEK on each request —
 * would couple KEK rotation to a full re-encrypt of every token row.
 * Storing the wrapped DEK lets the KEK rotate independently: re-wrap the
 * DEKs in place, ciphertext untouched.
 *
 * ``wrapped_dek`` layout: ``nonce || ciphertext || tag`` from AES-256-GCM
 * with KEK as the key and ``tenant_id`` as Additional Authenticated Data.
 * AAD binding means an attacker who swaps a wrapped DEK to a different
 * tenant_id row trips authentication and the unwrap fails.
 */
export const tenantKeys = pgTable('vs_tenant_keys', {
  tenantId: text('tenant_id').primaryKey(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

export type TenantKey = typeof tenantKeys.$inferSelect;
export type NewTenantKey = typeof tenantKeys.$inferInsert;
