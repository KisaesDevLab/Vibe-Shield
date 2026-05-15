from __future__ import annotations

from fastapi.testclient import TestClient


def test_request_size_limit_enforced(client: TestClient) -> None:
    # Conftest sets max_request_bytes=4096 for tests.
    payload = {"text": "a" * 5000}
    r = client.post("/analyze", json=payload)
    assert r.status_code == 413
    assert "max_bytes" in r.json()["detail"]


def test_request_under_limit_passes_size_check(client: TestClient) -> None:
    # Body well under 4 KB; route may still 422 without model loaded, but it must
    # not be 413.
    r = client.post("/analyze", json={"text": "small"})
    assert r.status_code != 413
