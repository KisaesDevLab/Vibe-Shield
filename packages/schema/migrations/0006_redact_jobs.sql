-- Phase D — Redact job model (BUILD_PLAN §4 Phase 17 + UI-Build-Addendum §4.2).
--
-- One row per user-initiated document redaction. Artifacts (source,
-- per-page rasters, redacted PDF, extracted MD + JSON, audit log)
-- live on disk under
-- ``/var/lib/vibe-shield/redact/jobs/<id>/``; the DB row is the
-- metadata + state machine. Lifetime: pending → running → completed
-- or failed; completed jobs auto-expire after ``expires_at``.

CREATE TABLE vs_redact_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES vs_users(id) ON DELETE RESTRICT,
    /** Operator-supplied filename (sanitized). For display + the
     *  Content-Disposition header of downloads. */
    filename            TEXT NOT NULL,
    /** Original MIME, sniffed by the gateway. */
    mime                TEXT NOT NULL,
    /** Size of source.<ext> on disk in bytes. */
    source_size_bytes   BIGINT NOT NULL,
    /** Page count for PDFs; 1 for single images. NULL until
     *  rasterization runs (status >= running). */
    pages_count         INTEGER,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    /** Free-text reason when status='failed'. */
    error_message       TEXT,
    /** Set when the worker picks the job up. */
    started_at          TIMESTAMPTZ,
    /** Set when the pipeline returns (success OR failure). */
    finished_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    /** Per BUILD_PLAN §8 Phase H: artifacts purge after this time. */
    expires_at          TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);
--> statement-breakpoint

CREATE INDEX vs_redact_jobs_user_idx   ON vs_redact_jobs(user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX vs_redact_jobs_status_idx ON vs_redact_jobs(status) WHERE status IN ('pending', 'running');
--> statement-breakpoint
CREATE INDEX vs_redact_jobs_expiry_idx ON vs_redact_jobs(expires_at) WHERE status = 'completed';
