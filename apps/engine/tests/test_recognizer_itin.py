from __future__ import annotations

from app.recognizers.itin import VsUsItinRecognizer, _itin_middle_valid
from tests.conftest import requires_model


def test_itin_middle_range_unit() -> None:
    assert _itin_middle_valid("70") is True
    assert _itin_middle_valid("88") is True
    assert _itin_middle_valid("50") is True
    assert _itin_middle_valid("65") is True
    assert _itin_middle_valid("90") is True
    assert _itin_middle_valid("99") is True
    # Out-of-range middle groups
    assert _itin_middle_valid("00") is False
    assert _itin_middle_valid("66") is False
    assert _itin_middle_valid("69") is False
    assert _itin_middle_valid("89") is False
    assert _itin_middle_valid("93") is False


def test_itin_validate_result_unit() -> None:
    rec = VsUsItinRecognizer()
    assert rec.validate_result("987-70-1234") is True
    assert rec.validate_result("912-88-4567") is True
    assert rec.validate_result("912-66-4567") is False  # invalid middle
    assert rec.validate_result("812-70-1234") is False  # doesn't start with 9


@requires_model
def test_itin_detected_with_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "ITIN on file is 987-70-1234 for the nonresident filer."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_ITIN" in types
