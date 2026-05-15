from __future__ import annotations

from tests.conftest import requires_model


@requires_model
def test_business_name_llc(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Invoice from Acme Bookkeeping LLC was paid."},
    )
    spans = r.json()["results"]
    matches = [s for s in spans if s["entity_type"] == "BUSINESS_NAME"]
    assert matches, f"expected BUSINESS_NAME in {spans}"


@requires_model
def test_business_name_pc(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Engagement letter signed by Smith & Jones, P.C."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "BUSINESS_NAME" in types


@requires_model
def test_business_name_inc(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Riverside Holdings, Inc. acquired the parcel."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "BUSINESS_NAME" in types


@requires_model
def test_lowercase_llc_in_prose_not_matched(client) -> None:  # type: ignore[no-untyped-def]
    # Lower-case "your llc" should not match (no capitalized preceding word).
    r = client.post(
        "/analyze",
        json={"text": "Have you registered your llc with the state?"},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "BUSINESS_NAME" not in types
