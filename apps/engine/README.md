# vibe-shield-engine

Internal-only PII redaction engine. Python 3.12 + FastAPI + Presidio.

**Not exposed externally.** Only the gateway calls it, on the internal Docker network.

Phase 2 of [BUILD_PLAN.md](../../BUILD_PLAN.md) scaffolds the FastAPI app, recognizers, and Docker image. This directory currently holds only the project envelope (`pyproject.toml`) so `uv sync` works during Phase 1 verification.

## Local dev (once Phase 2 lands)

```bash
uv sync
uv run uvicorn app.main:app --reload --port 8000
```
