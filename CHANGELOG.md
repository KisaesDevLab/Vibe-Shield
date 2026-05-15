# Changelog

All notable changes to Vibe Shield are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
