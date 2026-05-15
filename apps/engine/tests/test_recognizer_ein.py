from __future__ import annotations

from app.recognizers.ein import VALID_PREFIXES, VsUsEinRecognizer
from tests.conftest import requires_model


@requires_model
def test_ein_detected_with_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post("/analyze", json={"text": "Our EIN is 12-3456789 on file."})
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_EIN" in types


@requires_model
def test_ein_detected_with_alternate_label(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Federal ID 27-9999999 was assigned at incorporation."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_EIN" in types


@requires_model
def test_ein_invalid_prefix_rejected(client) -> None:  # type: ignore[no-untyped-def]
    # 07 is not in VALID_PREFIXES — validate_result should drop it even
    # though the regex matches the shape.
    assert "07" not in VALID_PREFIXES
    r = client.post("/analyze", json={"text": "Reference 07-1234567 in the footer."})
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_EIN" not in types


def test_ein_validate_result_unit() -> None:
    rec = VsUsEinRecognizer()
    assert rec.validate_result("12-3456789") is True
    assert rec.validate_result("07-1234567") is False  # invalid prefix
    assert rec.validate_result("99-9999999") is True   # 99 is valid
