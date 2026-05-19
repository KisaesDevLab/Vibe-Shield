-- v1.8 — Phase 26 (Module 2: Scan) foundation.
--
-- A scan job points the engine at a file or zip archive and gets back
-- a list of files containing unredacted PII. Each finding is one
-- (entity_type, severity, location) hit inside one inner file.
--
-- The job, files, and findings are all keyed off the same user (RBAC
-- gate is the gateway's job; the schema just supports the partition).
--
-- Severity is a denormalized text field for now (low/medium/high);
-- gateway computes it from entity_type using the same policy that
-- Redact uses for backstop logging.

CREATE TABLE vs_scan_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES vs_users(id) ON DELETE RESTRICT,
    source_kind       TEXT NOT NULL,          -- 'file' | 'archive'
    source_name       TEXT NOT NULL,          -- the original upload filename
    source_mime       TEXT NOT NULL,
    source_size_bytes BIGINT NOT NULL,
    -- Aggregate counters, updated as the engine streams findings.
    files_count       INTEGER NOT NULL DEFAULT 0,
    findings_count    INTEGER NOT NULL DEFAULT 0,
    findings_high     INTEGER NOT NULL DEFAULT 0,
    findings_medium   INTEGER NOT NULL DEFAULT 0,
    findings_low      INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    error_message     TEXT,
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);
--> statement-breakpoint

CREATE INDEX vs_scan_jobs_user_idx ON vs_scan_jobs(user_id, created_at DESC);
--> statement-breakpoint

-- Files contained in the scan source. For a single-file upload there's
-- one row; for a zip archive there's one per inner file actually
-- scanned (encrypted / skipped entries are not represented here).
CREATE TABLE vs_scan_files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES vs_scan_jobs(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,    -- relative path inside the source
    mime            TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    sha256          TEXT NOT NULL,    -- 64 hex chars
    skipped_reason  TEXT,             -- non-null = the engine couldn't scan it
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_scan_files_job_idx ON vs_scan_files(job_id);
--> statement-breakpoint

-- One row per detected PII span. snippet_redacted carries a tiny
-- context window with the entity itself replaced by <ENTITY_TYPE>;
-- the cleartext span never lives in the DB (hard rule #1).
CREATE TABLE vs_scan_findings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id            UUID NOT NULL REFERENCES vs_scan_jobs(id) ON DELETE CASCADE,
    file_id           UUID NOT NULL REFERENCES vs_scan_files(id) ON DELETE CASCADE,
    entity_type       TEXT NOT NULL,
    severity          TEXT NOT NULL,   -- 'low' | 'medium' | 'high'
    -- Location identifier — semantics vary by scanner:
    --   PdfTextScanner:    "page=3,char=120-129"
    --   CsvScanner:        "row=42,col=B (Account Number)"
    --   OfficeDocScanner:  "sheet=Sheet1,cell=B17"
    --   PlainTextScanner:  "line=88,char=12-21"
    location          TEXT NOT NULL,
    -- Tiny redacted context window; safe to surface in the SPA.
    snippet_redacted  TEXT NOT NULL,
    -- SHA-256(cleartext) — lets us dedupe + audit without storing PII.
    sample_hash       TEXT NOT NULL,
    -- v1.8: always false. v1.9 introduces user suppression with audit.
    suppressed        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_scan_findings_job_idx ON vs_scan_findings(job_id, severity);
--> statement-breakpoint

CREATE INDEX vs_scan_findings_file_idx ON vs_scan_findings(file_id);
