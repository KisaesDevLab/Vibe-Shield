from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import requires_model


@requires_model
def test_analyze_returns_spans(client: TestClient) -> None:
    r = client.post(
        "/analyze",
        json={"text": "Email me at jane.doe@example.com about the W-9."},
    )
    assert r.status_code == 200
    spans = r.json()["results"]
    assert any(s["entity_type"] == "EMAIL_ADDRESS" for s in spans)
    for s in spans:
        assert 0 <= s["start"] < s["end"]
        assert 0.0 <= s["score"] <= 1.0


@requires_model
def test_analyze_empty_text_rejected(client: TestClient) -> None:
    r = client.post("/analyze", json={"text": ""})
    assert r.status_code == 422
