# Changelog

All notable changes to Vibe Shield are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
