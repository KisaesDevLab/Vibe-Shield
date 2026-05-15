from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import requires_model


@requires_model
def test_health_reports_loaded(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["recognizers_count"] > 0
    assert body["version"]


@requires_model
def test_recognizers_endpoint_lists_defaults(client: TestClient) -> None:
    r = client.get("/recognizers")
    assert r.status_code == 200
    body = r.json()
    assert body["model"]
    names = {x["name"] for x in body["recognizers"]}
    # Sanity check that Presidio's default registry is present.
    assert any("Email" in n for n in names)
    assert any("Ssn" in n or "SSN" in n for n in names)


@requires_model
def test_metrics_endpoint_exposes_prometheus(client: TestClient) -> None:
    # Drive at least one request first so a metric line is emitted.
    client.get("/health")
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "vs_engine_http_requests_total" in r.text


@requires_model
def test_metrics_counts_entities_by_type(client: TestClient) -> None:
    client.post("/analyze", json={"text": "Email jane.doe@example.com today."})
    r = client.get("/metrics")
    # The entities-detected counter should have at least one EMAIL_ADDRESS row.
    assert r.status_code == 200
    assert "vs_engine_entities_detected_total" in r.text
    assert 'entity_type="EMAIL_ADDRESS"' in r.text


@requires_model
def test_recognizers_endpoint_shape(client: TestClient) -> None:
    r = client.get("/recognizers")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["recognizers"], list)
    assert body["model"]
    # Each entry must have the four documented fields and no others.
    for rec in body["recognizers"]:
        assert set(rec.keys()) == {"name", "supported_entities", "supported_language", "version"}
        assert isinstance(rec["supported_entities"], list)


@requires_model
def test_recognizers_endpoint_includes_custom_vs_recognizers(client: TestClient) -> None:
    r = client.get("/recognizers")
    names = {x["name"] for x in r.json()["recognizers"]}
    # Spot-check that our Phase 3 prefix-namespaced recognizers are registered.
    expected = {
        "VsUsEinRecognizer",
        "VsUsBankRoutingRecognizer",
        "VsUsBankAccountRecognizer",
        "VsUsItinRecognizer",
        "VsUsDateOfBirthRecognizer",
        "VsUsDriversLicenseRecognizer",
        "VsBusinessNameRecognizer",
    }
    assert expected.issubset(names), f"missing custom recognizers; got: {sorted(names)}"
