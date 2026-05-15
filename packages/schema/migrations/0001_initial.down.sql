-- Reverse of 0001_initial.sql. Drops in dependency-safe order.

BEGIN;

DROP TRIGGER IF EXISTS vs_audit_no_update ON vs_audit;
DROP TRIGGER IF EXISTS vs_audit_no_delete ON vs_audit;
DROP FUNCTION IF EXISTS vs_audit_reject_mutation();

DROP TABLE IF EXISTS vs_tenant_keys;
DROP TABLE IF EXISTS vs_recognizer_misses;
DROP TABLE IF EXISTS vs_audit;
DROP TABLE IF EXISTS vs_policies;
DROP TABLE IF EXISTS vs_token_index;
DROP TABLE IF EXISTS vs_tokens;
DROP TABLE IF EXISTS vs_sessions;

COMMIT;
