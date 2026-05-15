from __future__ import annotations

from tests.conftest import requires_model


@requires_model
def test_bank_account_detected_with_acct_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "Account # 123456789012 is the operating checking."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_BANK_ACCOUNT" in types


@requires_model
def test_bank_account_detected_with_dda_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "DDA 9876543210 balance was reconciled yesterday."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_BANK_ACCOUNT" in types


@requires_model
def test_bank_account_not_detected_without_context(client) -> None:  # type: ignore[no-untyped-def]
    # Same number shape, no banking context — must not be flagged as
    # account. (Presidio may still flag it as something else like
    # PHONE_NUMBER; we only assert the absence of US_BANK_ACCOUNT.)
    r = client.post(
        "/analyze",
        json={"text": "Invoice 123456789012 was paid on the 15th."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_BANK_ACCOUNT" not in types
