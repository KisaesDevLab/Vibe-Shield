-- Vibe Shield baseline schema (hand-written rather than drizzle-kit-
-- generated so the audit-immutability trigger ships alongside the
-- table it protects).

CREATE TABLE vs_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL,
    app_id      TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    policy_id   UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint

CREATE INDEX vs_sessions_tenant_idx  ON vs_sessions(tenant_id);
--> statement-breakpoint
CREATE INDEX vs_sessions_expires_idx ON vs_sessions(expires_at);
--> statement-breakpoint

CREATE TABLE vs_tokens (
    session_id          UUID NOT NULL REFERENCES vs_sessions(id) ON DELETE CASCADE,
    token               TEXT NOT NULL,
    entity_type         TEXT NOT NULL,
    cleartext_encrypted BYTEA NOT NULL,
    hash                BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, token)
);
--> statement-breakpoint

CREATE TABLE vs_token_index (
    session_id  UUID  NOT NULL REFERENCES vs_sessions(id) ON DELETE CASCADE,
    hash        BYTEA NOT NULL,
    token       TEXT  NOT NULL,
    PRIMARY KEY (session_id, hash)
);
--> statement-breakpoint

CREATE TABLE vs_policies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    version     INTEGER NOT NULL,
    json_config JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX vs_policies_name_version_uq ON vs_policies(name, version);
--> statement-breakpoint

CREATE TABLE vs_audit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    TEXT NOT NULL,
    session_id   UUID REFERENCES vs_sessions(id) ON DELETE SET NULL,
    event_type   TEXT NOT NULL,
    payload_hash BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_audit_tenant_created_idx ON vs_audit(tenant_id, created_at);
--> statement-breakpoint
CREATE INDEX vs_audit_event_idx          ON vs_audit(event_type);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION vs_audit_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'vs_audit is append-only; % rejected', TG_OP;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER vs_audit_no_update
    BEFORE UPDATE ON vs_audit
    FOR EACH ROW
    EXECUTE FUNCTION vs_audit_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER vs_audit_no_delete
    BEFORE DELETE ON vs_audit
    FOR EACH ROW
    EXECUTE FUNCTION vs_audit_reject_mutation();
--> statement-breakpoint

CREATE TABLE vs_recognizer_misses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern     TEXT NOT NULL,
    sample_hash TEXT NOT NULL,
    severity    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_recognizer_misses_pattern_idx ON vs_recognizer_misses(pattern);
--> statement-breakpoint
CREATE INDEX vs_recognizer_misses_created_idx ON vs_recognizer_misses(created_at);
--> statement-breakpoint

CREATE TABLE vs_tenant_keys (
    tenant_id   TEXT PRIMARY KEY,
    wrapped_dek BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rotated_at  TIMESTAMPTZ
);
