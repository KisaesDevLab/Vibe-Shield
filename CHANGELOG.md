# Changelog

All notable changes to Vibe Shield are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [1.6.0] — 2026-05-18

### Added — Phase 17 v1.6: per-page engine streaming + bulk-redact

Two UX-meaningful additions to the Redact module: live per-page SSE progress that actually fires *during* engine work (not after) for large PDFs, and bulk-upload of up to 50 files in one batch.

- **Engine** — `POST /redact-pdf` converted to a streaming `application/x-ndjson` response. One `{"type":"page", ...}` line per page emitted **as soon as the engine finishes that page**, followed by a `{"type":"summary", ...}` line with `pdf_sha256` + `pages_count` + concatenated token map. Mid-stream errors emit a `{"type":"error", ...}` line; the gateway treats it as a job failure. Fail-closed on bad PDF / missing poppler stays intact (raises before the stream opens).
- **Gateway stream consumer** — `EngineClient.redactPdf(bytes, opts)` now reads NDJSON line-by-line via `res.body.getReader()`, fires the optional `onPage(page)` callback per page, and aggregates into the existing `RedactPdfResponse` shape. 30-min timeout still bounds the whole call.
- **Pipeline** — `RedactPipeline` PDF path uses `onPage` to write per-page PNGs and emit `page_completed` SSE events the moment each page lands, instead of batching at the end. `markRunning(pageCount)` fires on the first page so the SPA progress bar can show the right denominator immediately.
- **Schema** — migration `0007_redact_batches.sql` adds `vs_redact_batches` (id, user_id, name, total_jobs, created_at) + nullable `vs_redact_jobs.batch_id` FK. Forward-compatible: existing single-file jobs keep `batch_id = NULL`.
- **Vault** — `RedactBatchStore` (create/findById/listForUser). `RedactJobStore.listForBatch(batchId)`. `RedactJobRecord` gains `batchId: string | null`.
- **Gateway routes** — `POST /v1/redact/batches` accepts up to 50 files in one multipart upload (`files[]`). Creates one batch row + one job per file (all sharing `batch_id`), responds 202 with the batch + jobs array, drains the pipeline sequentially in the background (engine is heavy; parallel would OOM). `GET /v1/redact/batches` lists own batches; `GET /v1/redact/batches/:id` returns the batch + aggregated `{pending,running,completed,failed}` summary + per-job array. Org_admin / redact_admin see across users; everyone else is owner-scoped.
- **Admin SPA** — `RedactView` dropzone accepts multiple files (drag a folder works in modern browsers). Single file uses the existing sync/async path; ≥2 files goes through the bulk endpoint. New `RedactBatchRow` type; `uploadRedactBatch(files, name)` client method.
- **Config** — no new env vars; the existing `REDACT_MAX_UPLOAD_BYTES` applies per file in a batch.

### Verification

**400 tests pass** locally against Postgres 16 + Redis 7 (5 client + 8 admin + 213 schema + 174 gateway including 14 redact integration tests; 3 new for v1.6):

- Bulk upload of 3 PNGs → batch created + 3 jobs sharing `batch_id` → sequential drain completes → `GET /batches/:id` returns `{summary: {completed: 3, failed: 0, pending: 0, running: 0}}`
- Non-owner gets 404 on cross-user batch read (existence hidden)
- Streaming `redactPdf` consumer: fake NDJSON stream with 2 pages + summary → `onPage` fires per page in order → aggregated response carries `pdf_sha256` and `pages_count: 2`

Plus the existing v1.5 PDF test now exercises the streaming path via the updated stub.

### Operator notes

- Engine image grew slightly to support streaming response (FastAPI `StreamingResponse` is already a dep). No new system packages.
- The bulk endpoint enforces the same per-file size cap as the single endpoint. Pre-upload validation in the SPA rejects unsupported MIMEs before the network hop.
- The pipeline still serializes batch jobs through the engine; this is intentional given engine OCR + face detection is CPU-heavy. Future v1.7 may introduce a small concurrency limit (engine permitting).
- Existing v1.4 / v1.5 jobs are forward-compatible: `batch_id` is NULL, batch endpoints simply don't return them. No migration of historical data.

## [1.5.0] — 2026-05-18

### Added — Phase 17 v1.5: PDF redaction + SSE progress + artifact-purge cron

PDF support arrives. Multi-page bank statements / 1099 packs / signed engagement letters get the same OCR + Presidio + face/signature/barcode treatment as single images, with real-time per-page progress in the SPA and automatic expiry-driven artifact cleanup.

- **Engine** — Dockerfile adds `poppler-utils` (~50 MB; provides `pdftoppm` + `pdfinfo`). `pdf2image==1.17.0` Python dep. New endpoint `POST /redact-pdf` accepts `{pdf_base64, dpi}` (DPI bounded 72-600, default 200), rasterizes pages, runs the existing image pipeline per page, returns structured per-page results + concatenated token map. Fails closed: any poppler / pdf2image / per-page error raises a 503 — the gateway never persists a partial result as completed.
- **Engine client** — `EngineClient.redactPdf(bytes, opts)`. 30-minute upper-bound timeout (≈30s/page worst case at 200 DPI on a NucBox M6); async path means HTTP doesn't actually block that long.
- **Gateway pipeline** — `RedactPipeline.run()` branches on MIME. Image path unchanged. PDF path calls `/redact-pdf`, writes per-page PNGs under `pages/`, assembles a multi-page redacted PDF via `pdf-lib` (one page per PNG, preserves dimensions), writes `extracted.md` with per-page sections and a concatenated token map. Per-page audit JSONL entries.
- **Async + SSE** — `RedactJobEvents` in-memory event broker. Upload route returns `202 Accepted` immediately for PDFs (the synchronous HTTP path stays for single images). New `GET /v1/redact/jobs/:id/stream` Server-Sent Events endpoint with `event: snapshot` on connect (catches up late subscribers) + live `page_started` / `page_completed` / `job_completed` / `job_failed` events. Heartbeat every 30s so intermediaries don't tear down idle connections. The SPA's `RedactView` consumes via `EventSource` and shows a per-page progress bar.
- **Purge cron** — `RedactPurgeCron` walks `RedactJobStore.findExpired()` hourly (configurable via `REDACT_PURGE_INTERVAL_MS`; 0 disables). Removes the on-disk directory + the DB row + writes a `redact_artifact_purged` audit event tagged `actorType: 'system'`. Failed jobs are kept for diagnosis.
- **Admin SPA** — `RedactView` accepts `.pdf` in the dropzone, shows per-page progress bar driven by SSE, and surfaces `pages_count` in the job detail header. Upload limit bumped 25 MB → 50 MB.
- **Config additions** — `REDACT_PURGE_INTERVAL_MS` (default 1h), `REDACT_MAX_UPLOAD_BYTES` default raised to 50 MB.
- **Appliance integration** — `docker-compose.fragment.yml` wires the new envs. `env.example` documents them. `manifest.json` `defaultTag` bumped to `v1.5.0`. The existing `vibe-shield-redact` named volume now also stores PDF-derived per-page rasters; no manifest change needed.

### Verification

**397 tests pass** against real Postgres + Redis — 11 redact integration tests now (8 from v1.4 + 3 new for v1.5):

- PDF upload → 202 + async pipeline → polling shows `completed` with `pages_count: 3` → assembled multi-page PDF downloads with valid `%PDF` header.
- Purge cron forced via past-expiry update + manual `runOnce()` removes both disk dir and DB row; subsequent GET returns 404.
- SSE stream: snapshot event for completed job + terminal `job_completed` event, stream closes cleanly.

Plus the existing v1.4 suite (no-session 401, no-role 403, image happy path, MIME rejection, viewer-only denial, org_admin cross-user, DELETE purge, engine-failure capture).

### Operator notes

- **PDF rasterization runs on the engine, not the gateway.** Update the engine image first (the appliance handles this via `vibe update vibe-shield`, which pulls all three images as a unit).
- The `/redact-pdf` engine endpoint refuses if `poppler-utils` isn't installed — the v1.5 engine image bundles it. If you build a custom engine image without poppler, PDF uploads will surface a 503 with `pdf rasterization failed`.
- The purge cron emits a `session_purge` audit row with `module='redact'`, `actorType='system'`, payload `{action: 'redact_artifact_purged', job_id, user_id, age_days}` for each cleaned job. Useful for compliance review.
- Existing v1.4 jobs aren't affected by the upgrade; their on-disk layout is forward-compatible.

## [1.4.0] — 2026-05-18

### Added — Phase 17 v1.4: user-facing Redact UI

A standalone, end-user-facing document-redaction surface on the appliance. Operators with a `redact` role drop an image, get back a redacted PDF + extracted markdown + token map. No external dependency on a calling Vibe app — Shield itself is now usable as the firm's primary redaction tool.

- **Schema** — migration `0006_redact_jobs.sql` adds `vs_redact_jobs` (UUID id, `user_id` FK, filename, mime, size, page count, status enum `pending|running|completed|failed`, error, timestamps, 30-day default `expires_at`). Indexes on `(user_id, created_at)` for the history view and a partial index on active statuses.
- **Vault** — `RedactJobStore` (create / find / list-for-user / list-all / markRunning / markCompleted / markFailed / reapStaleRunning for crash recovery / findExpired for the artifact-purge cron / delete).
- **Storage** — `apps/gateway/src/redact/storage.ts` owns the on-disk layout: `<REDACT_JOBS_DIR>/<job_id>/source.<ext>`, `pages/`, `redacted.pdf`, `extracted.md`, `extracted.json`, `audit.jsonl`. UUID gate + path-traversal check on every operation. Default base dir `/var/lib/vibe-shield/redact/jobs` (env-configurable). The appliance compose fragment mounts a named volume there for persistence across container recreates.
- **Pipeline** — `RedactPipeline` runs synchronously end-to-end: persist source → call engine `/redact-image` → write per-page raster + redacted PDF (PNG wrapped via `pdf-lib`) + extracted MD + JSON + audit JSONL → mark complete. Failures are captured into the row + audit log; the route always returns 201 with the current job state so the UI can render a `failed` pill without separate error handling.
- **Engine client** — new `EngineClient.redactImage(bytes)` method, base64-encodes the source for the existing `/redact-image` endpoint, gets back masked PNG + per-region bbox metadata + token map. 120s timeout (vs the 30s default) since OCR + face detection is heavier than text redaction.
- **Gateway endpoints** — all behind `requires('redact', <role>)` plus session-cookie or admin-key auth:
  - `POST /v1/redact/jobs` — multipart upload (`file` field). 25 MB cap by default. Operator role minimum.
  - `GET /v1/redact/jobs?limit=` — list (own jobs for non-admins; everyone's for org_admin / redact admin).
  - `GET /v1/redact/jobs/:id` — single job.
  - `GET /v1/redact/jobs/:id/artifacts/:kind` — download `source` | `redacted` | `extracted_md` | `extracted_json` with proper `Content-Type` + `Content-Disposition`.
  - `DELETE /v1/redact/jobs/:id` — purges the on-disk directory + the DB row. Operator role minimum.
- **Admin SPA** — new `RedactView` with drag-and-drop upload, status pill (pending / running / completed / failed), per-job detail panel with download buttons for each artifact, and a history table sorted newest-first. Sidebar entry visible to any user with a `redact` role (or `is_org_admin`). Default view on sign-in is now `redact` instead of `keys`.
- **Crash recovery** — gateway entry point calls `RedactJobStore.reapStaleRunning()` on boot, marking any job left in `running` state for >10 min as `failed` with a clear message. Users can re-upload.
- **Supported MIMEs (v1.4)** — PNG, JPEG, WebP, TIFF, BMP. PDF support lands in v1.5 with engine Dockerfile changes (poppler-utils + pdf2image).

**Verification**: 389 tests pass (5 client + 8 admin + 213 schema + 163 gateway including 8 new redact integration tests covering: no-session 401, no-role 403, upload-persist-download happy path, unsupported MIME rejection, viewer-only role denial, org_admin cross-user visibility, delete-purges-disk-and-DB, engine-failure-captured-into-row).

### Operator notes

- Set `VIBE_SHIELD_REDACT_MAX_UPLOAD_BYTES` if you want larger uploads than 25 MB.
- The persistent volume `vibe-shield-redact` survives container recreates. Backup it alongside Postgres.
- Per-job artifacts auto-expire 30 days after creation; the purge cron is a v1.5 follow-up (manual cleanup: `DELETE FROM vs_redact_jobs WHERE expires_at < now() AND status = 'completed';` + `rm -rf <REDACT_JOBS_DIR>/<id>` for each row).

## [1.3.0] — 2026-05-18

### Added — Phase 24: identity v2 (magic-link auth + per-module RBAC)

Replaces the single `GATEWAY_ADMIN_KEY` model with a real user table, per-module roles (viewer/operator/admin on redact/scan/compliance), magic-link sign-in, session cookies, and an admin SPA Users page. The legacy `X-Admin-Key` header continues to work as a parallel auth path for bootstrap and operator scripts.

- **Schema** — migration `0005_identity.sql` adds `vs_users` (email partial-unique-where-active, `is_org_admin`, `disabled_at` soft-delete, `last_login_at`), `vs_user_roles` ((user_id, module) PK with CHECK enums), `vs_magic_links` (single-use, 15-min TTL, hash-stored, `requested_ip` for forensics), `vs_user_sessions` (32-byte tokens, hash-stored, sliding 24h idle TTL, `revoked_at` tombstone).
- **Vault** — `UserStore` (create/find/setRole/disable/listAll + idempotent `setRole` upsert + `countActive()` for bootstrap), `MagicLinkStore` (issue with atomic single-use `DELETE ... RETURNING` consume + `reapExpired` cron), `UserSessionStore` (issue + atomic single-statement `validate-with-slide` via `UPDATE ... RETURNING` + revoke + revokeAllForUser). `roleSatisfies(actual, minimum)` for RBAC ranking.
- **Gateway** — `apps/gateway/src/auth/mailer.ts` wraps nodemailer with a plaintext-only magic-link email (no HTML, no tracking). `apps/gateway/src/auth/cookie.ts` is a hand-rolled cookie helper (HttpOnly + SameSite=Lax + Path=/ always; Secure when `NODE_ENV=production`). `apps/gateway/src/middleware/session-auth.ts` resolves the `vs_session` cookie and hydrates `req.user` with the per-module role map. `apps/gateway/src/middleware/requires.ts` exports `requires(module, role)` and `requiresOrgAdmin()` middleware factories.
- **Auth routes** — `POST /api/auth/request-link` (anti-enumeration: 204 + audit row whether the email exists or not), `GET /api/auth/consume?token=…` (validates + sets cookie + 302s to `/`), `POST /api/auth/logout` (revokes server-side + audits unconditionally), `GET /api/auth/me`. When SMTP is unset, `request-link` returns 501 with a clear message; admin-key path continues to work.
- **Admin endpoints** — `GET/POST /v1/admin/users`, `PUT /v1/admin/users/:id/roles`, `DELETE /v1/admin/users/:id/roles/:module`, `PUT /v1/admin/users/:id/org-admin`, `DELETE /v1/admin/users/:id`. `UserExistsError` maps to 409 `ConflictError`. Inviting a user issues a magic link when SMTP is configured; the response carries `invited: bool`. `adminAuthMiddleware` accepts an `org_admin` session OR the `X-Admin-Key` header.
- **Bootstrap admin** — when no *active* user exists AND `BOOTSTRAP_ADMIN_EMAIL` is set, the email is created as `is_org_admin=true` with admin role on all three modules + a system-actor `user_created` audit row. Counts only active users so a disabled bootstrap admin gets replaced on restart.
- **Admin UI** — `LoginGate` rewritten with magic-link request (default) + admin-key paste (fallback). On load the SPA probes `GET /api/auth/me`; success → authenticated UI, 401 → `LoginGate`. New `UsersView` (org_admin only) — invite + per-module role grid + org-admin toggle + disable. Sidebar shows the signed-in email + an `org admin` chip.
- **Caddy + Vite** — `appliance/caddy.snippet` routes `/api/auth/*` to gateway on the admin domain so cookies set same-origin. Vite dev proxy forwards `/api/auth/*` to `http://127.0.0.1:8080` for local development.
- **Audit** — six new event types: `user_created`, `user_disabled`, `user_role_changed`, `user_org_admin_changed`, `magic_link_requested`, `magic_link_consumed`. Every user mutation (create / role set / role revoke / org-admin toggle / disable) writes an audit row with from→to deltas. All identity events tagged `module='identity'`.

### Fixed — aggressive review-pass for v1.3

Three parallel review agents (security + audit hygiene + code quality) audited Phases 23.5 / 24 / 25 before release; 12 actionable defects surfaced and fixed. Pattern matches the v1.1.3 aggressive review.

**Critical**

- `MagicLinkStore.consume()` was SELECT-then-DELETE in two round-trips; concurrent consume calls with the same token could both authenticate. Collapsed to a single `DELETE ... RETURNING`.
- `UserSessionStore.validate()` was SELECT-then-UPDATE; a revoke between the two reads could be lost. Collapsed to `UPDATE ... WHERE (still valid) ... RETURNING`.
- Bootstrap admin counted all users including disabled ones; if the bootstrap admin got disabled and the appliance restarted, no replacement was created. `UserStore.countActive()` now drives the bootstrap path.
- Bootstrap admin creation was silent; now writes a system-actor `user_created` audit row.
- Corrupted `vs_appliance_settings` ciphertext silently fell back to env, masking tampering. Decrypt errors now fail closed with a fatal log; `ApplianceSettingsMissingError` (row absent) stays benign.

**High**

- `UserExistsError` escaped as 500. New `ConflictError` (409) + `POST /v1/admin/users` catches the race-window error.
- Magic-link `request-link` wrote an audit row only when the user existed (audit-table enumeration channel). Now audits always with `payload.outcome ∈ {sent, no_user}`.
- Logout was silent when the cookie was already gone. Audits unconditionally with `had_cookie` field.

**Medium**

- Six new `AuditEventType` values replace the workaround use of unrelated types in Phase 24 code.
- `setOrgAdmin`, `disable`, and `revokeRole` now emit audit rows with from→to deltas.
- `PromptRegistry` parser hardened against DoS: 1 MB whole-file cap, 10 KB per-frontmatter-value cap, 100-line closing-fence scan cap.
- OpenAPI spec bumped to `info.version='1.3.0'`; eight new endpoint paths documented.
- `env.example` and `docker-compose.fragment.yml` expose `VIBE_SHIELD_PROMPTS_DIR` and `VIBE_SHIELD_SPEND_RATE_PER_MINUTE`.

**Workflow**

- `.github/workflows/ci.yml` adds `workflow_dispatch: {}` so CI can be manually triggered (`gh workflow run CI --ref <branch>`) when GitHub's auto-trigger misses a PR.

**Verification**

Full local integration suite green against Postgres 16 + Redis 7: **386/386 tests passing**, zero failures, zero skips. The previously-deferred integration tests (160 schema + 70 gateway) all exercise the v1.3 critical paths — magic-link end-to-end, admin Anthropic-key set/revert, RBAC denial paths, every Phase 24 audit emission. These are the tests that validate the 12 review-pass fixes actually work.

### Added — Phase 25: egress wrapper consolidation deltas

Three small but defensive changes that tighten the egress boundary around the Anthropic API.

- **G2.6 — Versioned prompt template registry.** New `apps/gateway/src/prompts/registry.ts` loads `*.md` templates from `PROMPTS_DIR` at startup, parses minimal YAML frontmatter (`id`, `description`, `model_hint`), and computes SHA-256 of each file's raw bytes. `PromptRegistry.get(id)` returns the parsed template + SHA so a future caller (Phase 28 internal API) can record the SHA in the audit row of every Claude call. Admin UI gets a read-only `Prompts` view listing the loaded templates and their fingerprints. Loader skips invalid templates with a warn-level log; missing directory is a clean no-op (registry stays empty until Phase 28 introduces concrete consumers).
- **G2.8 — Per-tenant per-minute spend rate cap.** New `apps/gateway/src/quota/spend-rate-limiter.ts`. Fixed 60-second window, Redis-backed (`vs:srl:<tenant>:<window>` keys with 65s TTL). Pre-flight check throws `SpendRateLimitExceededError` once a tenant hits 100%; the orchestrator maps that to 429 + Retry-After. Soft-warn at 80% via the logger and an optional callback hook (audit-friendly). Configurable via `SPEND_RATE_PER_MINUTE_MICRODOLLARS` (default $100/min); set to 0 to disable. Sits alongside the existing month-cap — the month-cap stops *sustained* spend, this stops the *rate*, so a runaway worker can't burn through a month of budget in 10 minutes.
- **G2.9 — Anthropic egress boundary enforcement.** ESLint `no-restricted-imports` rule blocks `@anthropic-ai/sdk` imports from anywhere under `apps/gateway/src/**` except `apps/gateway/src/anthropic/`. New `apps/gateway/src/anthropic/types.ts` re-exports the SDK types the rest of the gateway needs (`Message`, `MessageCreateParamsNonStreaming`, etc.) so consumers route through the wrapper module instead of touching the package directly. New `scripts/check-anthropic-boundary.sh` is the CI belt-and-braces — runs from `make boundary` (wired into `make verify`); regex-tightened so doc comments referencing the SDK aren't false positives; works with `rg` or falls back to `find` + `grep` so it runs anywhere.

Test additions: 9 unit tests on `PromptRegistry` (valid load, SHA stability across edits, malformed/duplicate handling, README skip, slug validation, missing directory) and 7 on `SpendRateLimiter` (FakeRedis stub; per-tenant isolation, cap-zero short-circuit, soft-warn-once-per-crossing, retry-after surface).

### Added — Phase 23.5: admin Anthropic-key management

The admin UI can now rotate the Anthropic API key without an appliance redeploy. The env-set `ANTHROPIC_API_KEY` remains the bootstrap fallback; once an operator sets a key via the admin SPA it is persisted encrypted under the appliance KEK and overrides the env value on the next request.

- **Schema** — `0003_appliance_settings.sql` adds `vs_appliance_settings` (singleton row, AES-256-GCM ciphertext + SHA-256-prefix fingerprint). `0004_audit_module.sql` extends `vs_audit` with `module` / `actor_type` / `service_name` columns; historic rows backfilled.
- **Vault** — `ApplianceSecretStore` wraps/unwraps the key with AAD `vs:appliance:anthropic_key` so a per-tenant DEK can't be substituted in.
- **Gateway** — `AnthropicClientHolder` provides `getClient()` / `getSdk()` / `reload(opts)` so rotation takes effect on the next request. Orchestrator + streaming consume via accessors; reprobe loop reads the live key via `getApiKey()`.
- **Admin API** — `GET / PUT / DELETE /v1/admin/anthropic/key`. PUT probes Anthropic before persisting; DELETE refuses with 409 when no env fallback. Audit rows carry the fingerprint only, never plaintext.
- **Admin UI** — `AnthropicProbeView` restructured into three panels: status, set/rotate, revert.

### Docs

- **`BUILD_PLAN.md`** rewritten to incorporate `UI-Build-Addendum.md`. New §2.5 (product surface / modules), new Phases 23.5–30 covering identity v2 + per-module RBAC, egress wrapper deltas, Module 2 (Scan), Module 3 (Compliance), internal service API + MyBooks SDK, licensing tiers, release packaging. Phases 23.5 / 24 / 25 marked **shipped, v1.3**. The addendum's single-FastAPI-container architecture is explicitly rejected; the 3-service split is canonical.
- **`UI-Build-Addendum.md`** marked superseded with a status banner; body retained for traceability.
- **`appliance/INSTALL.md`** — new SMTP / `BOOTSTRAP_ADMIN_EMAIL` / cookie-flag section for Phase 24; note that env-set `ANTHROPIC_API_KEY` is bootstrap-only and admins rotate via the SPA.

## [1.1.4] — 2026-05-16

### Added — appliance integration kit (Phase 21 §A: Shield-side surfaces)

Per `.shield-build/open-decisions.md::D1`, Vibe Shield ships only the appliance-side surfaces; the appliance manifest itself lives in the Appliance repo. v1.1.4 packages those surfaces into a copy-paste integration kit so the Appliance team can land Shield in under 10 minutes.

- **`appliance/docker-compose.fragment.yml`** — 3 services (engine, gateway, admin) + 1 one-shot (`vibe-shield-migrate`, `profiles: [bootstrap]`). Reuses the appliance's existing `vibe-network` + Postgres + Redis (env-configurable). Image tag pinned via `${VIBE_SHIELD_VERSION}`; defaults to v1.1.3.
- **`appliance/caddy.snippet`** — 2 site blocks: `shield.<domain>` (admin SPA, Tailscale-only by default; path-routes `/v1/admin/*` to the gateway) and `gateway.shield.<domain>` (Anthropic-shaped API, Tailscale-only). Reusable `tailscale_only` matcher; commentable for LAN-wide deployments.
- **`appliance/env.example`** — every env var documented with required-vs-optional + generation commands. Required: `ANTHROPIC_API_KEY`, `VS_KEK`, `VIBE_SHIELD_DATABASE_URL`, `VIBE_SHIELD_REDIS_URL`, `VIBE_SHIELD_ADMIN_KEY`. 11 optional tunables with defaults.
- **`appliance/INSTALL.md`** — operator one-pager: prereqs, 8-step install, upgrade path, routine ops table, uninstall, hard-rule posture for auditors, troubleshooting table.
- **`packages/schema/scripts/wipe-vault.ts`** — secure-uninstall script. Triple-gated: `--apply` flag + `VIBE_SHIELD_WIPE_CONFIRM=WIPE-VAULT` env + interactive row-count match (or `--audit-rows=N` for unattended). Bounded to `vs_*` tables + the `drizzle` schema; can't wipe an unrelated DB. `make wipe-vault-dry` / `make wipe-vault-apply` targets.
- **`apps/admin/Dockerfile`** (new) — multi-stage Vite build → nginx serve. Final image **74 MB**. SPA fall-through to `/index.html` for client-side routing; long-cache on hashed `/assets/*`.
- **`.github/workflows/release.yml`** — admin added to the multi-arch GHCR build matrix; `ghcr.io/kisaesdevlab/vibe-shield-admin:v1.1.4` ships on the v1.1.4 tag.

## [1.1.3] — 2026-05-16

### Added — aggressive code review pass

Reading 172 source files across 4 workspaces (engine, gateway, schema, admin) — delegated to 4 parallel Explore agents and synthesized. Found 60+ raw findings; triaged to 9 actionable defects + 7 new regression tests. Full report at `.shield-build/REVIEW_REPORT_v1.1.3.md`.

### Security

- **`apps/gateway/src/config.ts`** — URL protocol allowlists for `DATABASE_URL` (postgres:/postgresql:), `REDIS_URL` (redis:/rediss:), `ENGINE_URL` (http:/https:). Blocks `file://`, `javascript://`, `gopher://`, etc. from sneaking in via partially-attacker-controlled orchestration env. 11 new vitest cases.
- **`apps/gateway/src/middleware/correlation-id.ts`** — CRLF + length sanitization on `x-correlation-id` header. Defense-in-depth — Node's HTTP parser already rejects CRLF at the wire, but this guards in-process direct invocation. Regex `/^[A-Za-z0-9_:.-]{1,128}$/`. 7 new vitest cases.
- **`packages/schema/src/crypto/kek.ts`** — `loadKek()` deletes `process.env.VS_KEK` after reading. Prevents recovery via `/proc/self/environ`, child-process env inheritance, debug tools. Caller-supplied envs (tests) NOT mutated. 2 new vitest cases.

### Audit hygiene

- **`apps/engine/app/tokenizer/deterministic.py`** — `TokenAllocation.__repr__` masks `cleartext`. Default dataclass repr would print cleartext if anything stringifies the object via stray `f"{allocation}"` log call.
- **`apps/engine/app/image/pipeline.py`** — `ImageRedactionResult.__repr__` masks `tokens` cleartext + `masked_image_bytes` blob. Same posture + avoids dumping image bytes into logs. 3 new pytest cases for both reprs.

### API contract / documentation

- **`apps/gateway/src/routes/openapi.ts`** — documents all 6 `/v1/admin/*` endpoints (api-keys list/issue/revoke, audit, recognizer-misses, anthropic probe, policies). Adds `adminKey` security scheme + 3 new schemas (`ApiKeyRow`, `AuditRow`, `RecognizerMissRow`). OpenAPI `info.version` bumped `0.1.0` → `1.1.3`.
- **`BUILD_PLAN.md`** — `Node.js 20` → `Node.js 24` (reconciles long-standing drift noted in user memory).
- **`README.md`** — Redis dev port updated `6379` → `6395`; `REDIS_PORT` override documented.

### Tests

7 new regression tests pinning the cumulative round-1 / round-2 / review fixes:
- `apps/gateway/tests/error-envelope.test.ts` (+2): Retry-After header on HttpError; rounds + clamps to 1
- `apps/gateway/tests/admin-routes.test.ts` (+5, new file): admin route reachable with X-Admin-Key only (regression for Defect #4); cleartext-key-once; idempotent revoke
- Plus the 11 + 7 + 2 + 3 = 23 unit-test cases under "Security" / "Audit hygiene" above.

Suite total grew gateway 52 → 72, schema 38 → 40, engine 314 → 317.

### Spend-cap race documented (deferred to v1.2)

`SpendTracker.checkCap()` and `record()` are not atomic — under sustained concurrency, N requests can pass the check before any record, producing worst-case overage of N × max-per-call cost. Sub-cent on Haiku, single-digit cents on Opus. v1.2 fix path: serializable txn with `SELECT ... FOR UPDATE` on the aggregate, or Redis pre-reservation. Inline comment documents both options.

## [1.1.0] — 2026-05-15

Closes 9 of the 12 v1.1 backlog items from the post-v1.0 punch list (§3 in the original `What's left to build` survey). The remaining three (§3.5 spend-cap webhook alert, §3.6 streaming SSE recorded-fixture coverage, §3.8 PolicyResolver cache invalidation) are operational refinements that don't change the user-facing surface; they roll forward to v1.2.

### Headline result

The v1.0 B1 precision blocker is closed. Measured on `qa/reports/baseline-v1.1-lg.json` (46 fixtures, `en_core_web_lg`):

| Entity | v1.0 | v1.1 |
|---|---|---|
| `US_BANK_ACCOUNT` precision | 0.45 | **1.00** |
| `PHONE_NUMBER` precision | 0.77 | **1.00** |
| `PERSON` precision | 0.92 | **1.00** |

Recall preserved at 1.00 across all measured tier-A entities. The QA harness's `PRECISION_GATE_EXEMPT` is now the empty set — the 0.90 floor is unconditional.

### What shipped

- **§3.1** B1 precision fix: pre-recognizer protected ranges + cross-type span deconfliction (PR #14)
- **§3.2** real image-redaction backends: Tesseract OCR + Pillow masking + OpenCV Haar face detection + pyzbar barcode/QR (PR #15)
- **§3.3** minimal admin UI + `/v1/admin/*` REST API (PR #18)
- **§3.4** daily audit-digest cron writer (PR #16)
- **§3.7** periodic Anthropic key re-probe (PR #16)
- **§3.9** canonical (deterministic) `safeStringify` (PR #16)
- **§3.10** k6 load test scripts encoding BUILD_PLAN §19 SLOs (PR #17)
- **§3.11** multi-arch (`linux/amd64,linux/arm64`) image release (PR #17)
- **§3.12** hard-rule-2 lint extends to Python (PR #16)

Detailed change notes for each section follow.

### Added — v1.1 §3.3: minimal admin UI + admin REST API (Phase 13)

Closes the v1.1 admin-UI scope per `.shield-build/open-decisions.md::D5`. New `apps/admin/` workspace + `/v1/admin/*` REST surface in the gateway.

**Frontend** (`apps/admin/`):
- Vite 6 + React 18 + TypeScript scaffolding. Hand-rolled minimal CSS — Tailwind / shadcn deferred to v1.2 to keep the bundle small and the dev loop fast.
- `LoginGate` holds the admin key in memory only. Refresh re-prompts. No localStorage / sessionStorage.
- 5 views: **API Keys** (list / issue / revoke), **Audit Log** (filterable by tenant), **Recognizer Misses** (sample-hash + severity), **Anthropic Probe** (run-now button), **Policies** (read-only list).
- `AdminClient` wraps fetch with X-Admin-Key auth; never logs the key or response bodies; surfaces errors as `AdminApiError` with status + endpoint only.
- 4 vitest cases pin the auth header + body serialization + 204 handling + 4xx error mapping.

**Backend** (`apps/gateway/src/routes/admin.ts`):
- New `adminRouter` mounted at `/v1/admin/*`. Auth middleware uses `timingSafeEqual` against `GATEWAY_ADMIN_KEY` env var. When the env var is unset, every admin request 401s (admin disabled).
- Endpoints:
  - `GET /v1/admin/api-keys` — list all issued keys (cleartext never returned).
  - `POST /v1/admin/api-keys` — issue, returns cleartext key ONCE.
  - `DELETE /v1/admin/api-keys/:id` — revoke by hex hash; idempotent.
  - `GET /v1/admin/audit?tenant_id=…&limit=…` — recent audit events with hex payload hashes.
  - `GET /v1/admin/recognizer-misses?limit=…` — recent backstop misses.
  - `POST /v1/admin/anthropic/probe` — invoke `AnthropicKeyReprobe.runOnce`.
  - `GET /v1/admin/policies` — read-only summary list (JSON editing deferred to v1.2 per D5).
- All endpoints fail closed when their backing dep isn't configured; no silent degradation.

**Schema additions**:
- `ApiKeyStore.list()` and `ApiKeyStore.revokeByHashHex()` for the admin UI helpers; no change to existing `issue` / `resolve` / `revoke` API.
- `AuditLogger.listRecent({ tenantId?, limit? })` with limit capped at 500.
- `RecognizerMissStore.listRecent({ limit? })` with the same cap.
- New exports: `AdminApiKeyView`, `AdminAuditView`, `AdminMissView`.

**Config**:
- `GATEWAY_ADMIN_KEY` (optional). When unset, admin API disabled.

**Out of scope for v1.1** (deferred per D5): policy editor (JSON view UI + PUT route), tenant management, dashboards / charts, validation runner UI.

### Added — v1.1 Tier C polish (§3.10 k6, §3.11 multi-arch)

- **§3.10 — k6 load test scripts** (`qa/load/`). Two scripts encode the BUILD_PLAN §19 SLOs as k6 thresholds:
  - `engine-redact.js` — 30 VU × 60s against `/redact`. P50 < 80ms / P99 < 300ms / failure rate < 0.1%.
  - `gateway-messages.js` — 5 VU × 60s against `/v1/messages` (full path incl. Anthropic). P50 < 150ms / P99 < 600ms / failure rate < 0.5%.
  - Synthetic Faker-derived prompts only; never logs response bodies; failed-threshold runs exit non-zero. Not part of per-PR CI (cost + Anthropic rate limits) — intended for pre-release smoke + perf-regression diagnosis. README documents invocation.
- **§3.11 — multi-arch image release**. `release.yml` adds `docker/setup-qemu-action@v3` and switches build platforms to `linux/amd64,linux/arm64`. GHCR receives a manifest list per tag; arm64 unblocks the Pi 5 future-deployment path called out in BUILD_PLAN §20.

### Added — v1.1 §3.2: real image-redaction backends (Phase 17 v1.1)

The v1.0 image pipeline shipped the API surface + per-page workflow + audit-event type behind a stub OCR. v1.1 wires the production backends without changing the API contract — Converter / GLM-OCR consumers can drop in the new image without code changes.

- **`apps/engine/app/image/ocr_tesseract.py`** — `TesseractOcrBackend`. Per-word text + bboxes via `pytesseract.image_to_data`. Default page-segmentation mode 6 ("uniform block of text") matches financial-document layout. `min_word_confidence=30` filters Tesseract's documented "low-quality" floor without dropping real PII. Failures (binary missing, image unreadable) raise `OcrUnavailable` → fail-closed 503.
- **`apps/engine/app/image/masker.py`** — `apply_solid_black_mask`. Pillow-based painter that draws solid-black rectangles over every `MaskedRegion`. Preserves source format (PNG/JPEG/WebP), preserves dimensions, preserves alpha for RGBA PNGs. Empty region list → input bytes returned unchanged.
- **`apps/engine/app/image/face_detector.py`** — `HaarFaceDetector`. OpenCV Haar-cascade frontal face detector using the bundled `haarcascade_frontalface_default.xml`. Defaults: `scaleFactor=1.1`, `minNeighbors=5`, `minSize=30×30`. Catches photo-ID faces (driver's license, passport bio page) and selfies in identity-verification flows. MediaPipe / DNN deferred to v1.2 pending training-data licensing (open-decisions.md::D6).
- **`apps/engine/app/image/barcode_detector.py`** — `PyzbarBarcodeDetector`. libzbar-backed barcode/QR decoder. Redacts QR, PDF417 (driver licenses), CODE128, EAN/UPC, CODABAR, I25, DATABAR. Decoded payload **never** appears in logs — only a SHA-256-truncated hash is recorded for audit attribution.
- **`apps/engine/app/image/pipeline.py`** — `ImageRedactor` gains `face_detector` and `barcode_detector` constructor args. Pipeline order: OCR → text analyzer → text-region mapping → face detection → barcode detection → mask all regions. Each step has its own fail-closed error path. No-op `_NoFaceDetector` / `_NoBarcodeDetector` defaults preserve the v1.0 test contract.
- **`apps/engine/app/main.py`** — `_get_image_redactor` lazily builds the singleton `ImageRedactor` on first `/redact-image` hit, gated by three new config flags.
- **`apps/engine/app/config.py`** — three new env-driven flags: `VS_ENGINE_IMAGE_OCR_ENABLED`, `VS_ENGINE_IMAGE_FACE_DETECTION_ENABLED`, `VS_ENGINE_IMAGE_BARCODE_DETECTION_ENABLED`. All default to `false` so unit tests keep getting deterministic stubs; the production Dockerfile flips them all to `true`.
- **`apps/engine/Dockerfile`** — installs `tesseract-ocr` + `tesseract-ocr-eng` + `tesseract-ocr-osd`, `libzbar0`, `libgl1`, `libglib2.0-0`. Default image gains all three image flags. Final image **1.13 GB** — under the BUILD_PLAN §2 cap of 2.5 GB; +570 MB delta over v1.0.1's 565 MB stub-only build.
- **`apps/engine/pyproject.toml`** — adds `pillow==11.0.0`, `pytesseract==0.3.13`, `opencv-python-headless==4.10.0.84`, `pyzbar==0.1.9` to runtime deps; `qrcode>=8.2` to dev deps for test fixture generation. Mypy `ignore_missing_imports` extended for `pytesseract`, `pyzbar`, `cv2`.
- **15 new pytest cases** (`tests/test_image_backends_v1_1.py`). Synthetic test images generated at runtime (no binary fixtures in git): PIL-rendered text for OCR, qrcode-generated PNGs for barcode, blank canvases for face-detector negatives. Tests cleanly skip when the local env lacks tesseract/libzbar (CI runs them inside the engine Docker image where everything is present). Engine suite total: **314 passed, 4 skipped**.

### Added — v1.1 Tier B operational gaps (§3.4, §3.7, §3.9, §3.12)

Four small-surface operational items the v1.0 release shipped without. Each is independently mergeable.

- **§3.4 — daily audit-digest cron writer**. New `packages/schema/scripts/write-audit-digest.ts` + `make audit-digest` target. Computes the SHA-256 hash-chained digest of every `vs_audit` row for a UTC date and writes it to `compliance/audit-digests/<YYYY-MM-DD>.txt` with mode `0440` and the `wx` flag (refuses to overwrite — defeats tamper evidence). Defaults to *yesterday*; `--date YYYY-MM-DD` for back-fill; `--force` documented as an operator escape hatch with no policy backing. Cron line: `0 5 0 * * *   node packages/schema/dist/scripts/write-audit-digest.js`.
- **§3.7 — periodic Anthropic key re-probe**. New `apps/gateway/src/anthropic/reprobe.ts`: `AnthropicKeyReprobe` runs every `ANTHROPIC_REPROBE_INTERVAL_MS` (default 15 min, set to 0 to disable). Failures emit a structured `warn` log with `reason: consumer_key | unreachable | unknown` so admins see revocation before the next paying request fails. Never crashes the server — the existing 401/503 paths handle the actual request failure. Wired in `index.ts` boot/shutdown. 7 new pytest cases (fake-timer driven).
- **§3.9 — canonical `safeStringify`**. Replaced the v1.0 shallow-key-sort in `audit-logger.ts` with a recursive walk so nested objects are also key-sorted at every depth. Audit-digest tamper evidence depends on this. Drops `undefined` from objects, preserves `null`, serializes `bigint` with `n` suffix (`JSON.stringify` would throw), throws on cycles. 10 new test cases pin the determinism contract.
- **§3.12 — hard-rule-2 lint extends to Python**. `scripts/check-no-anthropic-direct.sh` now greps `*.py` files for `from anthropic` / `import anthropic` outside the (currently empty) Python allowlist. Same fail-closed semantics as the TS check. Confirms the engine + qa harness never talk to Anthropic directly.

Misc:
- `Makefile` gains `audit-digest` target.
- `packages/schema/package.json` gains `audit-digest` script.
- Gateway `config.ts` gains `ANTHROPIC_REPROBE_INTERVAL_MS` (default 900_000 ms).

### Added — v1.1 §3.1: B1 precision fix (cross-type span deconfliction + protected ranges)

Closes the v1.0 B1 blocker. Two new layers in the engine analyzer pipeline; CHANGELOG-summary measurements on `qa/reports/baseline-v1.1-lg.json` (46 fixtures, `en_core_web_lg`):

| Entity | v1.0 (sm) | v1.1 (lg) |
|---|---|---|
| `US_BANK_ACCOUNT` precision | 0.45 | **1.00** |
| `PHONE_NUMBER` precision | 0.77 | **1.00** |
| `PERSON` precision | 0.92 | **1.00** |

Recall preserved at 1.00 across all measured tier-A entities (SSN, EIN, ROUTING, EMAIL, CREDIT_CARD).

- **`apps/engine/app/recognizers/protected_ranges.py`** (new). Computes contiguous text regions for currency / dates / tax-form numbers up front; the whitelist post-processor and backstop layer both consult these ranges. **Any Presidio span or backstop hit overlapping a protected range by even one character is dropped.** Closes the over-redaction case where `US_BANK_ACCOUNT` extracted `4,201.33` from inside `$4,201.33` (the digit-run substring didn't match the v1.0 substring-equality whitelist). `US_DOB` is exempt from the drop — context promotion already vetted it.
- **`apps/engine/app/recognizers/deconflict.py`** (new). Tier-priority cross-type span deconfliction. Presidio's recognizers cross-fire on the same digit run with different entity types — a 9-digit ABA routing number arrives back as `US_BANK_ROUTING` (correct) plus `US_BANK_ACCOUNT`, `PHONE_NUMBER`, `US_DRIVER_LICENSE`, and `US_BANK_NUMBER` (all false positives). Each duplicate counts as a precision-killing FP. The deconflict step keeps only the highest-priority span per overlapping cluster:
  - **Tier A (90)**: SSN, EIN, BANK_ROUTING, EMAIL, DOB, BUSINESS_NAME, PASSPORT, ITIN, CREDIT_CARD
  - **Tier B (60)**: PERSON, LOCATION, BANK_ACCOUNT, IBAN
  - **Tier C (40)**: PHONE_NUMBER, URL
  - **Tier D (10)**: DATE_TIME, US_DRIVER_LICENSE, BANK_NUMBER alias, AU/UK/IN/KR national IDs

  DATE_TIME and US_DRIVER_LICENSE are tier D because both Presidio recognizers fire on any digit-shaped string. Real dates land in protected ranges; real driver licenses are caught by our context-aware US-state recognizer.
- **`apps/engine/app/analyzer.py`** — wires the two new layers into both `analyze` and `analyze_with_misses`. Pipeline order: Presidio → `compute_protected_ranges` → `apply_whitelists(...)` → `deconflict_overlapping_spans(...)` → `BackstopLayer.apply_with_misses(...)`. Each step has its own EngineUnavailable error path so a failure anywhere fails-closed.
- **`qa/corpus/synthetic/statements.py`** (new). 12 new synthetic fixtures covering Chase personal/business checking, Bank of America personal, Wells Fargo small-business, AmEx business credit card. Header excerpts only (multi-line free-form addresses omitted to keep the harness signal clean). All names from Faker; account numbers format-valid but never issued; CREDIT_CARD uses Stripe's documented AmEx test card `378282246310005` (15 digits, Luhn-valid).
- **`qa/recall_precision.py`** — corpus is now `bookkeeping_fixtures() + statement_fixtures()` (46 total). `PRECISION_GATE_EXEMPT` reduced to the empty set — the 0.90 precision floor now applies to every measured entity unconditionally. `QA_SPACY_MODEL` env var lets the harness target lg without code edits.
- **27 new pytest cases** (`tests/test_protected_ranges.py`, `tests/test_deconflict.py`). Pin: span overlap policy, tier priority, US_DOB exemption, AmEx 15-digit Luhn, backstop-skipped-in-protected-range, miss-not-recorded-when-skipped.
- **`compliance/recognizers.md`** — new sections documenting protected ranges + cross-type deconfliction. Recognizer table now reports measured recall/precision (1.00 / 1.00 on lg) instead of `TBD — Phase 12` placeholders.
- **`.shield-build/blockers.md`** — B1 marked **RESOLVED v1.1** with the corrected root cause (cross-type cross-fire, not currency over-redaction as initially hypothesized).

### Operational

- `qa/reports/baseline-v1.1.json` (sm) and `qa/reports/baseline-v1.1-lg.json` (lg) — committed baselines for the regression gate.
- `QA_SPACY_MODEL=en_core_web_lg uv run --with pip python -m qa.recall_precision` — local lg run.

## [1.0.1] — 2026-05-15

### Added — production-readiness punch list (§1)

Operational gaps from v1.0 that surfaced before any real deployment. Single PR (#13), eight focused commits.

- **CI dry-run executed.** First real PR ran the full pipeline (Node + Python + image build) end-to-end. Two issues surfaced and were fixed: (a) `pnpm/action-setup@v4` `version: 9` conflicted with `packageManager: pnpm@9.15.0` in `package.json` — drop the action arg, `packageManager` is canonical; (b) Ruff `UP037` on `list["BackstopMiss"]` — `from __future__ import annotations` defers all annotations already, so the string quotes are unnecessary.
- **Gateway Dockerfile** (`apps/gateway/Dockerfile`). Node 24 multi-stage. Builder runs `pnpm install --frozen-lockfile` (incl. devDeps) then `pnpm exec tsc -p tsconfig.json` per workspace, then `pnpm --filter @kisaesdevlab/vibe-shield-gateway --prod deploy /pruned`. Runtime is non-root (`vibe:vibe`) with a `HEALTHCHECK` against `/health`. Final image **373 MB**. Release workflow matrix updated to build both engine and gateway; gateway uses workspace-root context for the schema dep.
- **Engine image size verified.** Replaced bash process substitution with `uv sync --frozen --no-dev` against the committed `uv.lock`; `uv run --with pip python -m spacy download ${SPACY_MODEL}` for `en_core_web_lg`. Final image **565 MB** — well under the BUILD_PLAN §2 acceptance criterion of 2.5 GB.
- **`vs_recognizer_misses` end-to-end wiring.** Engine `/redact` now returns a `misses: RecognizerMissEntry[]` field alongside spans. New `analyze_with_misses(...)` path in the analyzer + backstop layer keeps the legacy `analyze` API working. Gateway's redactor accumulates misses across multi-string requests; `RecognizerMissStore.recordBatch(...)` persists them best-effort to `vs_recognizer_misses`. Backstop misses are now queryable from SQL, not just observable in Pino logs.
- **KEK rotation script** (`packages/schema/scripts/rotate-kek.ts`). Two input modes: env vars (`OLD_VS_KEK` / `NEW_VS_KEK`) for unattended IR work, or `--interactive` for break-glass with hidden TTY entry. Mandatory mutually-exclusive `--dry-run` (counts rows, no writes) or `--apply` (single transaction over all `vs_tenant_keys` rows; rewraps DEK under the new KEK). Buffers zeroed in `finally`. Closes the IR runbook gap that referenced the missing `rewrap-keks.js`. Exposed via `make rotate-kek-dry` / `make rotate-kek-apply`.
- **OpenAPI spec refresh** (`apps/gateway/src/routes/openapi.ts`). v1.0.1 spec covers full `/v1/messages` request + response, `/v1/sessions/:id/materialize`, `/metrics`, `vs-session-id` response header, and every error envelope (400/401/403/429/503).
- **Migration tracking via Drizzle's `_journal.json`.** Replaced the hand-rolled `runMigrations` with Drizzle's official `migrate(db, { migrationsFolder })`. Migrations renumbered `0000_initial.sql` / `0001_api_keys.sql` / `0002_spend_records.sql` (zero-indexed); `_journal.json` indexes them. Drizzle's `__drizzle_migrations` tracking table prevents the `relation already exists` failure when re-running against a partially-migrated DB. Gateway no longer runs migrations at boot — deploy a one-shot `node packages/schema/dist/scripts/migrate.js` (or `make migrate`) before starting it. New `tsconfig.scripts.json` for the CLI scripts that fall outside `rootDir=src/`.
- **lg recall baseline** (`qa/reports/baseline-lg.json`). Production uses `en_core_web_lg`; the baseline was on `sm`. Re-ran the QA harness against `lg` and committed the report. **Recall 1.00 across every entity type**; PERSON precision 0.96 (vs 0.92 on `sm`); the B1 blocker (US_BANK_ACCOUNT 0.45 / PHONE_NUMBER 0.77 precision exemptions) holds — recall is compliant, precision tuning deferred to v1.1 architectural work.

### Fixed

- **Drizzle `--> statement-breakpoint` parser foot-gun.** Drizzle's split is naive — it doesn't parse SQL comments. The header comment in `0000_initial.sql` mentioned the literal phrase, so it got split into a stray comment chunk and Postgres rejected it. Removed the offending header text. Worth knowing for future migration authors.
- Two `_PoisonAnalyzer` / `_UnavailableAnalyzer` test classes updated to override `analyze_with_misses` (the route now uses it instead of `analyze`). Confirms the fail-closed contract still holds when the misses path raises.

### Operational

- **`make migrate`** — one-shot migration runner for the deploy pipeline.
- **`make rotate-kek-dry` / `make rotate-kek-apply`** — KEK rotation entry points for IR runbook step 4.

## [1.0.0] — 2026-05-15

### Added — Phase 8b: streaming, retry, rate limiting, spend caps

Closes Phase 8. Five things:

- **SSE streaming** (`apps/gateway/src/proxy/streaming.ts`). When the request carries `stream: true`, we open a streaming call to Anthropic, buffer trailing characters per content block until the next safe flush boundary (we hold from `<` until the matching `>` arrives so a token straddling two `text_delta` events isn't emitted half-resolved), re-identify on the fly, and forward as SSE to the client. Non-text events (`message_start`, `content_block_start`, etc.) pass through verbatim.
- **Retry/backoff** (`src/proxy/retry.ts`). Exponential backoff with full jitter. Retries Anthropic 429 + 5xx; never retries 4xx (request-side error) or our own redaction/vault errors. Default 3 attempts, 250 ms base, 8 s ceiling.
- **Per-tenant rate limit** (`src/quota/rate-limiter.ts`). Redis-backed fixed-window counter, default 60 req/min per (tenant, app). Configurable. Breach → 429 with Anthropic-shaped `rate_limit_error` envelope and `retryAfterSeconds`.
- **Per-tenant monthly spend cap** (`src/quota/spend-cap.ts`, new `vs_spend_records` table + migration `0003_spend_records.sql`). Records token counts + micro-dollar cost per Anthropic call. Pre-flight cap check → `SpendCapExceededError` → 403 `permission_error`. PRICING table snapshots Sonnet 4.6 / Opus 4.7 / Haiku 4.5 list prices; conservative fallback for unknown models. Default cap $500/month.
- **`vs-session-id` response header** echoes the session used by every `/v1/messages` call so clients can reuse it.

Config gained `REDIS_URL`, `RATE_LIMIT_PER_MINUTE`, `SPEND_CAP_MICRODOLLARS`. Gateway tests grew 36 → 56 (+20):
- **rate-limiter (6)** — under cap / at cap / tenant isolation / app isolation / per-call override / Retry-After hint shape
- **spend-cap (8)** — exact cost computation per Sonnet input/output, fallback price, integration record+read, cap breach, fresh tenant passes, tenant isolation, PRICING coverage
- **retry (6)** — first success / 5xx eventual / 429 retried / 4xx not retried / max attempts / unstatused errors not retried

### Added — Phase 8 (part 1): Anthropic Claude API proxy — non-streaming

Core end-to-end redaction pipeline live: `POST /v1/messages` accepts an Anthropic Messages API request, redacts every cleartext field through the Python engine, persists tokens in the per-session vault, calls Anthropic with the redacted payload, and re-identifies tokens in the response before returning to the client. The 501 from Phase 7 is gone.

- **`EngineClient`** (`apps/gateway/src/engine/client.ts`) — typed `fetch` wrapper for the engine's `/redact` / `/analyze` / `/health`. Per-call timeout, propagates `X-Correlation-Id`, sanitized `EngineUnreachableError` / `EngineFailureError` (no body content in error messages).
- **`probeAnthropicKey`** (`src/anthropic/probe.ts`) — startup commercial-key probe via direct `fetch` to `GET /v1/models` (decoupled from SDK version). 401/403 → `ConsumerKeyError`, fail-closed: gateway refuses to start. Error messages never echo the API key.
- **Anthropic client wrapper** (`src/anthropic/client.ts`) — wraps `@anthropic-ai/sdk` with optional `anthropic-zdr: enabled` header (gated on `ZDR_ENABLED`). Exposes a minimal interface tests can mock.
- **`PerTenantKeyResolver`** (`src/tenant-key/resolver.ts`) — `TenantKeyResolver` impl backed by `vs_tenant_keys`. First-touch provisioning: mints + wraps a new DEK if no row exists, racing safely on the unique PK. Caches cleartext DEKs for the request lifetime; `clear()` zeros them on shutdown.
- **Request redactor** (`src/proxy/redactor.ts`) — walks the Anthropic Messages request:
  - String content + system prompt → engine `/redact`, then re-mapped through the session vault so tokens are session-stable rather than per-request.
  - `tool_use.input` → recursive walk of arbitrary JSON, redacting only string values.
  - `tool_result.content` → strings + nested JSON.
  - Image blocks pass through (Phase 17).
- **Response re-identifier** (`src/proxy/reidentifier.ts`) — collects every `<ENTITY_N>` token in the response (text blocks, `tool_use.input`, `tool_result.content`), resolves them in parallel through the vault. **Unknown tokens pass through unchanged** — Anthropic occasionally hallucinates angle-bracketed text; we never resolve tokens that weren't allocated for this session.
- **Orchestrator** (`src/proxy/orchestrator.ts`) — ties it together. Honors `request.session_id` if supplied; otherwise opens an ephemeral session bound to the auth tenant. Anthropic 4xx → `invalid_request_error` (400); Anthropic 5xx → `engine_unavailable` (503). Phase 8b will add retry + circuit breaker.
- **`stream: true` returns 501 with the "Phase 8b" marker** — SSE proxy is the next phase, alongside Redis rate limiting + spend caps.
- **Config** gained `ANTHROPIC_API_KEY` (required) and `ZDR_ENABLED` (boolean, default false).
- **Gateway tests grew from 23 → 36 cases:**
  - **Probe (6)** — 200/401/403/5xx/network mapping; **error message never contains the API key**.
  - **Proxy (7)** — full SSN+name+email roundtrip with stub Anthropic (asserts outbound payload contains tokens not cleartext, asserts response re-identifies); system prompt redaction; recursive tool-use input redaction; auth required; `stream: true` → 501; Anthropic 4xx → 400; Anthropic 5xx → 503.

### Deferred to Phase 8b (next phase)
- SSE streaming for `stream: true` requests
- Retry/backoff with jitter on Anthropic transients
- Per-tenant rate limiting in Redis
- Per-tenant monthly spend caps
- Golden-recording test fixtures

### Added — Phase 7: Node.js gateway service skeleton

- `apps/gateway` workspace (`@kisaesdevlab/vibe-shield-gateway`): Express 5 + Pino + Zod, strict tsconfig matching `packages/schema`.
- New `vs_api_keys` table + migration `0002_api_keys.sql`. Key format: `vs_live_<24 base62 chars>` (~143 bits entropy). Only `SHA-256(full_key)` lands in the DB; cleartext is shown to the operator exactly once at issue time. `ApiKeyStore` in `packages/schema` with `issue` / `resolve` (with `timingSafeEqual` on the hash) / `revoke`. `ApiKeyInvalidError` / `ApiKeyRevokedError` distinguished.
- Middleware chain (order matters):
  - **Correlation ID** — honors `X-Correlation-Id`, mints a UUID v4 if absent, propagates via `AsyncLocalStorage` so the logger picks it up without thread-local plumbing.
  - **Access log** — Pino. Captures method / path / status / latency / request_bytes / tenant_id / app_id. Never the body. Custom `serializers` block default body capture.
  - **Size limit** — rejects oversized payloads before the JSON parser allocates.
  - **API key auth** — parses `Authorization: Bearer vs_live_…`, attaches `{ tenantId, appId, keyName }` to `req.auth`.
- Routes:
  - `GET /health` (liveness).
  - `GET /ready` (DB ping via `SELECT 1`).
  - `POST /v1/messages` — full Anthropic Messages API zod validation; returns 501 with an Anthropic-shaped envelope. The actual proxy (streaming, tool use, system-prompt scrubbing, consumer-key block) lands in Phase 8.
  - `POST /v1/sessions`, `GET /v1/sessions/:id`, `DELETE /v1/sessions/:id` — the endpoints Phase 6 deferred. Cross-tenant lookups return 404 (never 403) so existence isn't leaked.
  - `GET /openapi.json` — hand-written OpenAPI 3.1 spec.
- Anthropic-shaped error envelope (`{ type: "error", error: { type, message }, correlation_id }`) for every non-success response. Sanitized handlers for `ZodError` (field paths only — no `input` echo) and unhandled exceptions (logs `error_class`, returns generic 500).
- Tests (23 supertest+vitest cases, all integration against real Postgres):
  - **health/openapi/correlation (5)** — endpoint shape, OpenAPI spec validity, correlation-ID echo + auto-mint.
  - **auth (6)** — missing header, non-Bearer, malformed key, unknown key, revoked-key=403, valid-key=201.
  - **messages (5)** — 501 with Phase-8 message, 400 on missing model, 400 on wrong role, **PII fragments (`234-56-7890`, `Jane Doe`) never appear in any 400 validation body**, 401 without auth.
  - **sessions (7)** — create with default + custom TTL, malformed body=400, get-by-id, cross-tenant returns 404 not 403, non-UUID=400, delete-then-not-found.

### Added — Phase 6: Deterministic tokenization & session management

- `SessionManager` (`packages/schema/src/vault/session-manager.ts`): `create` / `get` / `touch` / `delete` / `purgeExpired` / `countActive`. Default 60-minute TTL per BUILD_PLAN §6; `SessionExpiredError` distinguishes expired-but-present from missing.
- `TokenVault` (`packages/schema/src/vault/token-vault.ts`): `allocate(sessionId, entityType, cleartext)` is transactional with `SELECT … FOR UPDATE` on the session row, so concurrent allocations within one session serialize to monotonic N. `resolve(sessionId, token)` decrypts under the per-tenant DEK and returns `null` for unknown tokens (so the gateway's re-identification pass leaves hallucinated tokens untouched).
- `tokenDedupeHash` (`packages/schema/src/vault/hash.ts`): HMAC-SHA-256(DEK, `sessionId || ":vs:" || cleartext`). Defeats rainbow-table attacks against `vs_token_index` and structurally enforces the BUILD_PLAN §6 cross-session privacy property.
- `TenantKeyResolver` interface lets callers inject DEK lookup. Tests use a `StaticKeyResolver`; Phase 7 will plug the gateway's wrapped-DEK cache.
- `createDatabase` + `runMigrations` (programmatic migration runner) — uses a dedicated `max:1` postgres-js client so the baseline migration's BEGIN/COMMIT block doesn't trip postgres-js's `UNSAFE_TRANSACTION` guard. `dropAllVibeShieldObjects` (scoped to `vs_*`) gives integration tests a clean slate.
- Integration tests against real Postgres (132 cases, gated on `DATABASE_URL`):
  - SessionManager: 9 cases including TTL respect, expired-throws, touch-bumps-expiry, GC purge, audit-trigger immutability assertion.
  - TokenVault: 12 cases including idempotency, monotonic N per (session, entity_type), separate counters per entity_type, cross-session distinct dedup hashes, cross-tenant distinct dedup hashes, expired-session refusal, missing-session refusal, vs_audit append-only trigger rejecting UPDATE and DELETE.
  - Roundtrip: 111 cases (25 SSNs × non-issued, 25 EINs × valid IRS prefixes, 25 emails, 25 person names, 10 boundary — unicode, emoji, multi-line, 2 KB string). Each case allocates a token, asserts the token shape, resolves back to the original cleartext, and re-allocates to confirm idempotency.
- `compliance/encryption.md` extended with the dedup-hash design and its three privacy properties.
- HTTP `POST /sessions` / `DELETE /sessions/:id` deferred to Phase 7 (gateway scaffolding) — Phase 6 ships the library; Phase 7 wires the routes.
- `docker-compose.yml`: Postgres host port remapped to 5436 (overridable via `POSTGRES_PORT`) so it doesn't collide with system Postgres or the MyBooks dev stack on 5434.

### Added — Phase 5: Token vault schema & encryption

- First TypeScript workspace: `packages/schema` (`@kisaesdevlab/vibe-shield-schema`) under pnpm with vitest + Drizzle ORM. Strict tsconfig (noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax).
- Drizzle schema for all six BUILD_PLAN §5 tables — `vs_sessions`, `vs_tokens`, `vs_token_index`, `vs_policies`, `vs_audit`, `vs_recognizer_misses` — plus `vs_tenant_keys` for wrapped per-tenant DEKs (BUILD_PLAN says "Per-tenant DEK wrapped by an appliance-level KEK" but does not enumerate the table; we add it so KEK rotation doesn't require re-encrypting every token row).
- `migrations/0001_initial.sql` — hand-written baseline, including a row-level trigger that rejects UPDATE / DELETE on `vs_audit` (BUILD_PLAN §11 "row-level immutability enforced via trigger"). Reversible `.down.sql` companion.
- AES-256-GCM helpers in `src/crypto/`: `encrypt`/`decrypt` (12-byte nonce, 16-byte tag, optional AAD), `loadKek()` (fail-closed if `VS_KEK` missing or wrong length), `createWrappedDek` / `unwrapDek` / `rewrapDek` (AAD-bound to `tenant_id` so cross-tenant row swaps fail authentication).
- `compliance/encryption.md` documents algorithm choices, key hierarchy, AAD binding rationale, nonce policy, key-lifetime ceiling (~2³² wraps before collision risk), and rotation procedure.
- Tests (vitest, 28 cases): AES-GCM roundtrip + tampering rejection, AAD binding, key-length validation; KEK load happy/sad paths; DEK wrap/unwrap including cross-tenant rejection and rotation roundtrip; schema export shape and inferred-type smoke tests; **a no-leak test that captures all stdout/stderr during a full crypto cycle and asserts no PII / no key bytes / no base64 keys appear**.

### Added — Phase 4: Regex backstop / deny-list layer

- Six deterministic backstops under `apps/engine/app/backstops/`, all defaulting to `Severity.BLOCK`:
  - `SsnBackstop` — SSA-range-excluded SSN regex per BUILD_PLAN §4 Phase 4.
  - `EinBackstop` — `\b\d{2}-\d{7}\b` with IRS valid-prefix list (shared with the recognizer).
  - `RoutingBackstop` — 9 digits + ABA checksum, explicitly rejects `000000000`.
  - `CreditCardBackstop` — 13–19 digits with optional space/hyphen separators + Luhn.
  - `EmailBackstop` — permissive RFC-ish.
  - `PhoneBackstop` — NANP variants (parens, dots, dashes, spaces, bare 10-digit) and E.164 with optional extension.
- `BackstopLayer` composes them, runs after Presidio + whitelist, and emits new spans only for hits that don't overlap an existing Presidio span. Each non-overlapping hit is a *miss*: handed to a `MissHandler` callable (default: structured log line with entity type, backstop name, severity, SHA-256-truncated `sample_hash` — never cleartext). Phase 5 plugs this into the `vs_recognizer_misses` Postgres table.
- `Severity` enum (`block` / `warn` / `allow`) controls the miss-escalation path; detection happens regardless.
- Wired into `AnalyzerService.analyze()` after the whitelist filter; the analyzer holds a single `BackstopLayer` instance per process.
- Compliance docs (`compliance/recognizers.md`) updated with the backstop table, severity ladder, miss-logging behavior, and fail-closed posture statement.
- Tests: 157 new cases in 7 files (`test_backstop_{ssn,ein,routing,credit_card,email,phone,layer}.py`). 20+ adversarial positive/negative cases per backstop. Layer-level integration covers overlap suppression, miss recording, hash determinism, and the full Presidio+layer pipeline. Full engine suite: 256 passing.

### Added — Phase 3: Custom CPA-domain recognizers

- Seven Vibe-Shield-prefixed Presidio recognizers under `apps/engine/app/recognizers/`:
  - `VsUsEinRecognizer` — `\b\d{2}-\d{7}\b` filtered by IRS-valid prefix list.
  - `VsUsBankRoutingRecognizer` — 9 contiguous digits with ABA checksum `(3a+7b+c+…) mod 10 == 0`.
  - `VsUsBankAccountRecognizer` — 4-17 digits gated by required context ("Account #", "Acct", "DDA", "checking", "savings"); base score 0.05 forces context boost before survival.
  - `VsUsItinRecognizer` — `9XX-YZ-XXXX` with IRS middle-group validation (50-65, 70-88, 90-92, 94-99).
  - `VsUsDateOfBirthRecognizer` — four date shapes (numeric slash/dash, ISO, written) with sub-threshold base scores so DOBs only fire when a "DOB" / "birthday" / "birth" context cue is in window.
  - `VsUsDriversLicenseRecognizer` — per-state pattern table for 15 states (CA, NY, TX, FL, IL, PA, OH, GA, NC, MI, NJ, VA, WA, AZ, MA) plus alphanumeric fallback gated by DL context.
  - `VsBusinessNameRecognizer` — title-cased phrase + corporate suffix (LLC, Inc., P.C., PLLC, LP, LLP, Ltd, …) with inline `(?-i:[A-Z])` to defeat Presidio's automatic IGNORECASE.
- All custom classes carry the `Vs` prefix to avoid colliding with Presidio's `__subclasses__()` discovery (Presidio's default YAML config attempts to instantiate same-named classes with `patterns=`/`context=` kwargs).
- `whitelists.apply_whitelists()` post-processes Presidio output: drops any span (regardless of entity type) whose text is currency, an ISO/US calendar date, or a tax-form number (`1099-NEC`, `W-2`, `1040`, …). Also suppresses partial matches like Presidio tagging only `1099` of `1099-NEC`. `US_DOB` is explicitly exempt — by construction it only survives with context.
- `AnalyzerEngine` now constructed with `default_score_threshold=0.4`; context-required recognizers (bank account, DOB) carry sub-threshold base scores so the boost is structurally necessary.
- DOB year-only generalization helper (`dob.generalize_to_year`) ready for Phase 6 / 10 strict policy.
- `compliance/recognizers.md` — required by BUILD_PLAN Phase 3 — documents pattern, source, context cues, and known limitations per recognizer. FP/FN columns marked `TBD — Phase 12` pending the recall harness.
- Tests: 36 new Phase-3 cases across `test_recognizer_{ein,aba_routing,bank_account,itin,dob,drivers_license,business_name}.py` and `test_whitelists.py`, each covering positive / negative / boundary cases plus unit-level checksum and validation helpers. Full suite: 99 passing.

### Added — Phase 2: Core Python redaction engine (Presidio base)

- FastAPI app at `apps/engine` with eager startup model load (fail-closed if spaCy model missing).
- Endpoints: `POST /analyze`, `POST /redact`, `GET /health`, `GET /recognizers`, `GET /metrics`.
- Pinned runtime deps: presidio-analyzer 2.2.358, presidio-anonymizer 2.2.358, spacy 3.7.5, transformers 4.46.3, fastapi 0.115.6, uvicorn 0.34.0, pydantic 2.10.4, pydantic-settings 2.7.0, python-json-logger 3.2.1, prometheus-client 0.21.1.
- Structured JSON logging with correlation IDs; non-allowlisted `extra` fields are silently dropped to make payload-body leaks structurally impossible.
- `RequestSizeLimitMiddleware` enforces a 256 KB default cap (configurable via `VS_ENGINE_MAX_REQUEST_BYTES`).
- Per-request `RequestTokenizer` produces deterministic `<ENTITY_N>` tokens; identical cleartext inside one request collapses to a single token. Session-scoped vault arrives in Phase 6.
- Multi-stage Dockerfile bundling `en_core_web_lg`; non-root runtime user; HEALTHCHECK wired to `/health`.
- Test suite: 50 synthetic fixtures across 10 base entity types (PERSON, EMAIL_ADDRESS, PHONE_NUMBER, US_SSN, CREDIT_CARD, IP_ADDRESS, LOCATION, DATE_TIME, URL, IBAN_CODE) plus health/recognizers/metrics, redact idempotency, tokenizer overlap handling, size-limit enforcement, and a payload-leak assertion on the logger.
- Makefile: new `engine-models` target downloads `en_core_web_sm` for the test suite; `make install` chains it.

### Added — Phase 1: Repository foundation & tooling

- PolyForm Internal Use 1.0.0 license.
- README with stack overview and quickstart.
- CLAUDE.md with hard rules (no cleartext in logs, commercial-key-only, fail-closed) and per-workspace conventions.
- pnpm workspaces (`apps/*`, `packages/*`); Node 24 engine constraint.
- Python engine project envelope (`apps/engine/pyproject.toml`) under uv; runtime deps deferred to Phase 2.
- Root tooling: ESLint flat config (with `no-console` enforcement), Prettier, Ruff, EditorConfig, .nvmrc.
- `docker-compose.yml` with Postgres 16 + Redis 7 always-on; gateway/engine/admin gated behind the `app` profile (Dockerfiles arrive in Phases 2/7/13).
- Makefile with `dev`, `install`, `lint`, `typecheck`, `test`, `build`, `verify`, `clean`.
- `.github/`: CODEOWNERS (`@KisaesDevLab/core`), bug / recognizer-miss / compliance-question issue templates, PR template requiring redaction recall regression confirmation.
- `.gitignore` blocking secrets, `qa/corpus/real/`, and Python/Node build artifacts.

### Notes

- Stack drift: BUILD_PLAN.md §2.1 specifies Node 20; the active kickoff prompt bumped to Node 24. CLAUDE.md and `package.json` use 24 — reconcile BUILD_PLAN.md when convenient.
- `docs/compliance-memo.md` is referenced by the kickoff prompt but not yet present in the repo.

