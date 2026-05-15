# Changelog

All notable changes to Vibe Shield are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
