-- vs_appliance_settings — Phase 23.5 admin Anthropic-key management.
--
-- BUILD_PLAN §4 Phase 23.5: an operator can paste, validate, and rotate
-- the commercial Anthropic API key from the admin UI. The plaintext key
-- is encrypted under the appliance KEK (AES-256-GCM, AAD bound to the
-- purpose "vs:appliance:anthropic_key") and persisted here. The env-set
-- ANTHROPIC_API_KEY remains the bootstrap fallback for fresh installs
-- and disaster recovery.
--
-- Singleton design: id is fixed to 1 by the CHECK constraint. We use a
-- table rather than a kv-row so future per-appliance settings can land
-- as sibling columns without a second migration scaffold.
--
-- Sensitive columns: anthropic_api_key_ciphertext is the encrypted blob
-- (nonce || ciphertext || tag from packages/schema/src/crypto/aead.ts).
-- anthropic_api_key_fingerprint is SHA-256(plaintext) truncated to the
-- first 16 hex chars — safe to display in admin UI and to write to the
-- audit log payload.

CREATE TABLE vs_appliance_settings (
    id                              SMALLINT PRIMARY KEY DEFAULT 1
        CHECK (id = 1),
    anthropic_api_key_ciphertext    BYTEA,
    anthropic_api_key_fingerprint   TEXT,
    anthropic_api_key_set_at        TIMESTAMPTZ,
    anthropic_api_key_set_by        TEXT,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Seed the singleton row so set/clear can always UPDATE without a
-- conditional UPSERT in the application layer. All fields start null.
INSERT INTO vs_appliance_settings (id) VALUES (1);
