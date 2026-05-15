# Changelog

All notable changes to Vibe Shield are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
