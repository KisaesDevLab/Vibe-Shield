# vibe-shield-engine

Internal-only PII redaction engine. Python 3.12 + FastAPI + Presidio + spaCy.

**Not exposed externally.** Only the gateway calls it, on the internal Docker network.

## Endpoints

| Method | Path           | Purpose                                          |
|--------|----------------|--------------------------------------------------|
| GET    | `/health`      | Liveness + model-load status                     |
| GET    | `/recognizers` | Active recognizers + entity coverage             |
| POST   | `/analyze`     | Detect PII spans (returns spans + scores)        |
| POST   | `/redact`      | Detect + tokenize (returns redacted text + map)  |
| GET    | `/metrics`     | Prometheus exposition                            |

`/redact` returns a per-request token map. Cross-request stability and the encrypted token vault land in Phase 5–6.

## Local dev

```bash
uv sync
uv run python -m spacy download en_core_web_sm   # for the test suite
uv run uvicorn app.main:app --reload --port 8000

# Production model (used by the Docker image):
uv run python -m spacy download en_core_web_lg
```

## Tests

```bash
uv run pytest                          # full suite
uv run pytest tests/test_recognizers.py -v   # 50+ synthetic fixtures
```

Tests that need the spaCy model are gated by the `requires_model` mark — they skip cleanly with a clear message if the model is absent.

## Hard rules in force

1. No request body, redacted text, or token map ever appears in a log record. Enforced by `app/logging.py` (allowlisted extra keys) and asserted by `tests/test_logging.py`.
2. Engine refuses to serve if the spaCy model fails to load (FastAPI lifespan handler raises).
3. Default request size cap: 256 KB. Override with `VS_ENGINE_MAX_REQUEST_BYTES`.
