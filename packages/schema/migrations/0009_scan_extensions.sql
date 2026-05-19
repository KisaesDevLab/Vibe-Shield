-- v1.9 — Phase 26 completion: bulk-redact links, scheduled scans,
-- and the suppression audit columns the v1.8 schema was forward-
-- compatible for.

-- One row per (scan_file -> redact_job) link created by the bulk-
-- redact endpoint. Lets the SPA show "this Redact job was queued
-- from Scan #abc" and the Scan view show "you've already redacted
-- 4 of these flagged files".
CREATE TABLE vs_scan_redact_links (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_job_id        UUID NOT NULL REFERENCES vs_scan_jobs(id) ON DELETE CASCADE,
    scan_file_id       UUID NOT NULL REFERENCES vs_scan_files(id) ON DELETE CASCADE,
    redact_job_id      UUID NOT NULL REFERENCES vs_redact_jobs(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scan_file_id, redact_job_id)
);
--> statement-breakpoint

CREATE INDEX vs_scan_redact_links_scan_idx ON vs_scan_redact_links(scan_job_id);
--> statement-breakpoint

CREATE INDEX vs_scan_redact_links_redact_idx ON vs_scan_redact_links(redact_job_id);
--> statement-breakpoint

-- Audit fields on the existing scan_findings table. v1.8 reserved
-- ``suppressed`` as a boolean default false; v1.9 adds who/when/why.
ALTER TABLE vs_scan_findings
    ADD COLUMN suppressed_by UUID REFERENCES vs_users(id) ON DELETE SET NULL,
    ADD COLUMN suppressed_at TIMESTAMPTZ,
    ADD COLUMN suppressed_reason TEXT;
--> statement-breakpoint

-- Scheduled scans. A scheduled scan re-runs against a "source ref"
-- on a cadence; the appliance scheduler polls this table every
-- minute. ``source_ref`` is opaque to the schema (a path on the
-- appliance volume, a URL, a glob pattern, etc.) — the
-- ScheduledScanRunner in the gateway interprets it. v1.9 ships
-- support for ``filesystem:<absolute path>`` only.
CREATE TABLE vs_scheduled_scans (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES vs_users(id) ON DELETE RESTRICT,
    name               TEXT NOT NULL,
    source_kind        TEXT NOT NULL,        -- 'filesystem' for v1.9
    source_ref         TEXT NOT NULL,
    -- Standard 5-field cron expression evaluated in UTC.
    cron_expression    TEXT NOT NULL,
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at        TIMESTAMPTZ,
    last_run_job_id    UUID REFERENCES vs_scan_jobs(id) ON DELETE SET NULL,
    next_run_at        TIMESTAMPTZ,
    -- Comma-separated list of email addresses. NULL disables email alerts.
    notify_emails      TEXT,
    -- Webhook URL + HMAC secret. Both must be set for delivery.
    webhook_url        TEXT,
    webhook_secret     TEXT,
    -- Only alert when a new run carries at least this severity.
    -- 'high' is the default to avoid noise; operators can drop to
    -- 'medium' for stricter monitoring.
    alert_min_severity TEXT NOT NULL DEFAULT 'high',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_scheduled_scans_user_idx ON vs_scheduled_scans(user_id);
--> statement-breakpoint

CREATE INDEX vs_scheduled_scans_next_run_idx
    ON vs_scheduled_scans(next_run_at)
    WHERE enabled = TRUE;
