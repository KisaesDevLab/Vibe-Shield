-- vs_spend_records — Phase 8b spend accounting.

CREATE TABLE vs_spend_records (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT NOT NULL,
    app_id             TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cost_microdollars  NUMERIC(18,0) NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_spend_records_tenant_created_idx
    ON vs_spend_records(tenant_id, created_at);
