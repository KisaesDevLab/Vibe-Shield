import {
  check,
  customType,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_appliance_settings — Phase 23.5 admin Anthropic-key management.
 *
 * Singleton table (id = 1, enforced by CHECK). Holds the operator-set
 * Anthropic key as AES-256-GCM ciphertext under the appliance KEK, plus
 * a fingerprint safe to display in the admin UI and the audit log. When
 * ciphertext is null the gateway falls back to the env-set
 * ``ANTHROPIC_API_KEY``; see ``getEffectiveAnthropicKey()`` in
 * ``apps/gateway/src/config.ts``.
 */
export const applianceSettings = pgTable(
  'vs_appliance_settings',
  {
    id: smallint('id').primaryKey().default(1),
    anthropicApiKeyCiphertext: bytea('anthropic_api_key_ciphertext'),
    anthropicApiKeyFingerprint: text('anthropic_api_key_fingerprint'),
    anthropicApiKeySetAt: timestamp('anthropic_api_key_set_at', {
      withTimezone: true,
    }),
    anthropicApiKeySetBy: text('anthropic_api_key_set_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check('vs_appliance_settings_singleton', sql`${table.id} = 1`)],
);

export type ApplianceSettingsRow = typeof applianceSettings.$inferSelect;
