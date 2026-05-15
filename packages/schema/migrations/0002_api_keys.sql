-- vs_api_keys — Phase 7. Gateway credentials.
-- key_hash is SHA-256(full_key); the cleartext is shown to the operator
-- exactly once at issuance.

BEGIN;

CREATE TABLE vs_api_keys (
    key_hash      BYTEA PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    app_id        TEXT NOT NULL,
    name          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX vs_api_keys_tenant_idx ON vs_api_keys(tenant_id);
CREATE INDEX vs_api_keys_app_idx    ON vs_api_keys(app_id);

COMMIT;
