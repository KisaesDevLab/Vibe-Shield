"""Hard-rule #1 enforcement for error paths.

The default FastAPI handlers echo user input (Pydantic ``input``) and
exception messages. This file verifies the custom handlers in
``app/errors.py`` produce sanitized envelopes that never leak the input
text.

If any test here fails, **stop the merge**. A regression in this file
means cleartext PII is reaching the wire in 422 / 500 / 503 responses.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.analyzer import AnalyzerService
from app.config import Settings
from app.errors import EngineUnavailable
from app.main import create_app
from tests.conftest import requires_model

CLEARTEXT_FRAGMENTS = (
    "234-56-7890",
    "Jane Doe",
    "jane.doe@example.com",
    "4111 1111 1111 1111",
)


def _assert_no_pii(body: str | bytes) -> None:
    text = body.decode() if isinstance(body, bytes) else body
    for fragment in CLEARTEXT_FRAGMENTS:
        assert fragment not in text, (
            f"PII fragment {fragment!r} leaked in response body: {text[:300]}"
        )


@requires_model
@pytest.mark.parametrize(
    "payload",
    [
        # text as a list — Pydantic echoes `input` by default
        {"text": ["SSN 234-56-7890 belongs to Jane Doe"]},
        # text as a dict
        {"text": {"raw": "SSN 234-56-7890 belongs to Jane Doe"}},
        # text as a number
        {"text": 234567890},
        # missing text but other fields contain PII as value
        {"language": "234-56-7890"},
        # extra invalid field with PII
        {"text": "ok", "entities": "234-56-7890 belongs to Jane Doe"},
        # PII in language field as wrong type
        {"text": "ok", "language": ["Jane Doe"]},
    ],
)
def test_422_validation_never_echoes_input(client: TestClient, payload: dict[str, Any]) -> None:
    r = client.post("/redact", json=payload)
    assert r.status_code == 422
    _assert_no_pii(r.text)
    body = r.json()
    assert body["error"] == "validation_error"
    # Sanitized envelope: details only carry loc + type, never the value.
    for detail in body["details"]:
        assert set(detail.keys()) <= {"loc", "type"}


@requires_model
def test_malformed_json_does_not_leak(client: TestClient) -> None:
    # Partial JSON containing PII — the parser error path must not echo bytes.
    r = client.post(
        "/redact",
        content=b'{"text": "SSN 234-56-7890 belongs to Jane Doe',
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 422
    _assert_no_pii(r.text)


@requires_model
def test_500_does_not_leak_input_when_internal_error(
    settings: Settings, analyzer: AnalyzerService
) -> None:
    """Inject a recognizer that always raises on text containing PII.

    The exception message includes the input substring. The 500 envelope
    must not echo it.
    """

    class _PoisonAnalyzer(AnalyzerService):
        def analyze(self, text: str, language: str | None = None, entities: list[str] | None = None):  # type: ignore[no-untyped-def, override]
            raise RuntimeError(f"poison: {text}")

    poisoned = _PoisonAnalyzer(spacy_model=settings.spacy_model, language=settings.default_language)
    if analyzer.is_loaded:
        poisoned._engine = analyzer.engine  # share engine to skip reload
    app = create_app(settings=settings, analyzer=poisoned)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post("/redact", json={"text": "SSN 234-56-7890 belongs to Jane Doe"})
    assert r.status_code == 500
    _assert_no_pii(r.text)
    body = r.json()
    assert body["error"] == "internal_error"


@requires_model
def test_503_when_pipeline_raises_engine_unavailable(
    settings: Settings, analyzer: AnalyzerService
) -> None:
    """A controlled EngineUnavailable raise should produce 503 + sanitized envelope."""

    class _UnavailableAnalyzer(AnalyzerService):
        def analyze(self, text: str, language: str | None = None, entities: list[str] | None = None):  # type: ignore[no-untyped-def, override]
            raise EngineUnavailable(f"redaction failed on: {text}")

    svc = _UnavailableAnalyzer(spacy_model=settings.spacy_model, language=settings.default_language)
    if analyzer.is_loaded:
        svc._engine = analyzer.engine
    app = create_app(settings=settings, analyzer=svc)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post("/redact", json={"text": "SSN 234-56-7890 belongs to Jane Doe"})
    assert r.status_code == 503
    _assert_no_pii(r.text)
    assert r.json()["error"] == "engine_unavailable"


@requires_model
def test_503_when_backstop_raises(settings: Settings, analyzer: AnalyzerService) -> None:
    """A backstop that raises during .find() must fail the request closed
    (503), not silently drop matches."""
    from app.backstops import BackstopLayer
    from app.backstops.base import BackstopHit  # noqa: F401  — type import for clarity

    class _BrokenBackstop:
        name = "broken"
        entity_type = "US_SSN"
        severity = None  # not used because we raise

        def find(self, text: str):  # type: ignore[no-untyped-def]
            raise RuntimeError(f"explode on: {text}")

    svc = AnalyzerService(spacy_model=settings.spacy_model, language=settings.default_language)
    if analyzer.is_loaded:
        svc._engine = analyzer.engine
    svc._backstop_layer = BackstopLayer(backstops=[_BrokenBackstop()])  # type: ignore[list-item]
    app = create_app(settings=settings, analyzer=svc)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.post("/redact", json={"text": "harmless input"})
    assert r.status_code == 503
    _assert_no_pii(r.text)


@requires_model
def test_500_envelope_includes_correlation_id(client: TestClient) -> None:
    # Force a 422 via bad payload, just to confirm the envelope shape.
    r = client.post(
        "/redact",
        json={"text": ["x"]},
        headers={"X-Correlation-Id": "test-cid-7890"},
    )
    assert r.status_code == 422
    assert r.json()["correlation_id"] == "test-cid-7890"
