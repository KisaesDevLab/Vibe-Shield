-- vs_audit — Phase 23.5 module / actor extension.
--
-- UI-Build-Addendum §4.6 (merged into BUILD_PLAN §4 Phase 23.5):
--   * `module` enum ('redact','scan','compliance','identity','egress','admin')
--   * `actor_type` enum ('user','service','system')
--   * `service_name` text (when actor_type='service')
--
-- Nullable for back-compat — existing rows are backfilled here, and the
-- audit-logger now requires `module` going forward but tolerates the
-- nullable columns on read so the admin UI still renders historic rows
-- without a frontend change.

ALTER TABLE vs_audit
    ADD COLUMN module       TEXT,
    ADD COLUMN actor_type   TEXT NOT NULL DEFAULT 'user',
    ADD COLUMN service_name TEXT;
--> statement-breakpoint

-- Backfill: every existing row is either an egress call (request /
-- reidentify / materialize / commercial_key_probe), an admin action
-- (api_key_* / policy_change), or identity-ish (session_*).
UPDATE vs_audit
   SET module = CASE
       WHEN event_type IN ('request','reidentify','materialize','commercial_key_probe',
                           'spend_cap_breached','rate_limit_breached')
           THEN 'egress'
       WHEN event_type IN ('api_key_issue','api_key_revoke','policy_change')
           THEN 'admin'
       WHEN event_type IN ('session_create','session_purge')
           THEN 'identity'
       WHEN event_type = 'recognizer_miss'
           THEN 'redact'
       ELSE 'admin'
   END
 WHERE module IS NULL;
--> statement-breakpoint

CREATE INDEX vs_audit_module_idx ON vs_audit(module);
