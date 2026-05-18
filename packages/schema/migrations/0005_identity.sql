-- Phase 24 — Identity v2: users + per-module RBAC + magic-link auth.
--
-- UI-Build-Addendum §4.3 + BUILD_PLAN §4 Phase 24. Replaces the single
-- GATEWAY_ADMIN_KEY model with a real user table. Per-module roles
-- (viewer/operator/admin) for redact/scan/compliance. An is_org_admin
-- bit bypasses every RBAC check (system administrators).
--
-- Auth is magic-link only in v1 of this phase — no passwords. The
-- gateway emails a one-time URL; clicking it consumes the link and
-- issues a session cookie. Sessions are sliding (24h idle TTL).
--
-- Schema hygiene: token hashes only. Cleartext magic-link tokens and
-- session tokens are returned to their owners exactly once (the link
-- in the email, the cookie in the response) and never persisted.

CREATE TABLE vs_users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    is_org_admin    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    disabled_at     TIMESTAMPTZ
);
--> statement-breakpoint

-- Lowercase the email at write time so uniqueness is case-insensitive.
CREATE UNIQUE INDEX vs_users_email_lower_uniq
    ON vs_users(LOWER(email))
    WHERE disabled_at IS NULL;
--> statement-breakpoint

CREATE TABLE vs_user_roles (
    user_id  UUID NOT NULL REFERENCES vs_users(id) ON DELETE CASCADE,
    module   TEXT NOT NULL CHECK (module IN ('redact','scan','compliance')),
    role     TEXT NOT NULL CHECK (role IN ('viewer','operator','admin')),
    PRIMARY KEY (user_id, module)
);
--> statement-breakpoint

CREATE INDEX vs_user_roles_module_idx ON vs_user_roles(module);
--> statement-breakpoint

-- Magic-link tokens. Cleartext returned in the email exactly once;
-- token_hash is SHA-256(cleartext). Consuming a link deletes its row
-- (single-use). Expired rows are reaped by a cron, not consulted at
-- consume-time (the expires_at check happens in the query).
CREATE TABLE vs_magic_links (
    token_hash      BYTEA PRIMARY KEY,
    email           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    requested_ip    TEXT
);
--> statement-breakpoint

CREATE INDEX vs_magic_links_email_idx ON vs_magic_links(email);
--> statement-breakpoint

-- Session tokens. token_hash = SHA-256(cleartext); cleartext lives only
-- in the HttpOnly cookie. Sliding TTL: last_seen_at bumps on every
-- request that resolves a session; expires_at = last_seen_at + idle.
CREATE TABLE vs_user_sessions (
    token_hash      BYTEA PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES vs_users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    user_agent      TEXT,
    revoked_at      TIMESTAMPTZ
);
--> statement-breakpoint

CREATE INDEX vs_user_sessions_user_idx ON vs_user_sessions(user_id);
