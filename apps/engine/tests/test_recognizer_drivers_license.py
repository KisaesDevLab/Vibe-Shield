from __future__ import annotations

from app.recognizers.drivers_license import STATE_PATTERNS, VsUsDriversLicenseRecognizer
from tests.conftest import requires_model


def test_state_patterns_cover_major_states() -> None:
    assert {"CA", "NY", "TX", "FL", "IL"}.issubset(STATE_PATTERNS.keys())


def test_state_pattern_examples() -> None:
    assert STATE_PATTERNS["CA"].match("A1234567")     # letter + 7 digits
    assert STATE_PATTERNS["CA"].match("X9999999")
    assert not STATE_PATTERNS["CA"].match("123456")    # too short, no letter

    assert STATE_PATTERNS["NY"].match("123456789")    # 9 digits
    assert STATE_PATTERNS["NY"].match("A1234567")     # letter + 7

    assert STATE_PATTERNS["TX"].match("12345678")     # 8 digits
    assert STATE_PATTERNS["TX"].match("1234567")      # 7 digits
    assert not STATE_PATTERNS["TX"].match("123456")   # 6 digits

    assert STATE_PATTERNS["FL"].match("A123456789012")  # letter + 12 digits


def test_validate_result_accepts_state_format_and_fallback() -> None:
    rec = VsUsDriversLicenseRecognizer()
    assert rec.validate_result("A1234567") is True       # CA shape — boost
    assert rec.validate_result("XYZ12345") is None       # fallback — no opinion
    assert rec.validate_result("ABCDE") is False         # too short — reject
    assert rec.validate_result("ABCDEF") is False        # no digit — reject


@requires_model
def test_dl_detected_with_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Driver's license A1234567 on file (CA)."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_DRIVER_LICENSE" in types


@requires_model
def test_dl_not_flagged_without_context(client) -> None:  # type: ignore[no-untyped-def]
    # Without DL context, an alphanumeric block should not be flagged by
    # our custom recognizer. (Presidio may flag other entity types; we
    # only check absence of US_DRIVER_LICENSE here.)
    r = client.post(
        "/analyze",
        json={"text": "Order A1234567 shipped to the warehouse."},
    )
    types_for_block = [
        s for s in r.json()["results"]
        if s["entity_type"] == "US_DRIVER_LICENSE" and "A1234567" in "ABCDEFGHIJ" + str(s["start"])
    ]
    assert types_for_block == []
