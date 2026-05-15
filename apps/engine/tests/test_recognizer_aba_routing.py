from __future__ import annotations

from app.recognizers.aba_routing import aba_checksum_valid
from tests.conftest import requires_model

# 011000015 — Federal Reserve Bank of Boston (publicly published routing,
# canonical example used in ABA documentation). Real-format checksum-valid
# value with no link to any individual.
VALID_ABA = "011000015"
# 322271627 — Chase Bank, San Francisco; another public example.
VALID_ABA_CHASE = "322271627"


def test_aba_checksum_valid_examples() -> None:
    assert aba_checksum_valid(VALID_ABA) is True
    assert aba_checksum_valid(VALID_ABA_CHASE) is True


def test_aba_checksum_invalid_examples() -> None:
    # Random 9-digit strings almost never check out.
    assert aba_checksum_valid("123456789") is False
    assert aba_checksum_valid("999999999") is False
    assert aba_checksum_valid("000000000") is True   # degenerate but checksum-valid
    assert aba_checksum_valid("12345678") is False   # wrong length
    assert aba_checksum_valid("12345678a") is False  # non-numeric


@requires_model
def test_aba_detected_with_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": f"Wire to routing number {VALID_ABA} by Friday."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_BANK_ROUTING" in types


@requires_model
def test_aba_checksum_invalid_not_detected(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Reference routing number 123456789 in the memo."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_BANK_ROUTING" not in types
