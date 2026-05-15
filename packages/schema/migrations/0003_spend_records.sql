-- vs_spend_records — Phase 8b. One row per Anthropic call for spend
-- accounting and per-tenant monthly cap enforcement.

BEGIN;

CREATE TABLE vs_spend_records (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT NOT NULL,
    app_id             TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    -- Cost in micro-dollars (USD * 1_000_000). NUMERIC(18,0) avoids
    -- float drift on accumulation across millions of rows.
    cost_microdollars  NUMERIC(18,0) NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX vs_spend_records_tenant_created_idx
    ON vs_spend_records(tenant_id, created_at);

COMMIT;
