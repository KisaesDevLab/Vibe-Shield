-- v1.6 — bulk-redact batches.
--
-- A batch is a user-initiated upload of N files; each file becomes
-- one vs_redact_jobs row, and they share a batch_id. Batches are
-- nullable on the job side so existing single-file uploads stay
-- untouched and forward-compatible.

CREATE TABLE vs_redact_batches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES vs_users(id) ON DELETE RESTRICT,
    name          TEXT,
    total_jobs    INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX vs_redact_batches_user_idx ON vs_redact_batches(user_id, created_at DESC);
--> statement-breakpoint

ALTER TABLE vs_redact_jobs
    ADD COLUMN batch_id UUID REFERENCES vs_redact_batches(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX vs_redact_jobs_batch_idx ON vs_redact_jobs(batch_id);
