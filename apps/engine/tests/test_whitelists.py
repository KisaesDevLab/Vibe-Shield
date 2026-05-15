from __future__ import annotations

from app.analyzer import EntitySpan
from app.recognizers.whitelists import (
    apply_whitelists,
    is_calendar_date,
    is_currency,
    is_tax_form,
)
from tests.conftest import requires_model


def test_currency_recognition() -> None:
    assert is_currency("$1,234.56") is True
    assert is_currency("$0.99") is True
    assert is_currency("-$50.00") is True
    assert is_currency("1,234.56 USD") is True
    assert is_currency("just text") is False
    assert is_currency("$") is False


def test_calendar_date_recognition() -> None:
    assert is_calendar_date("2024-03-15") is True
    assert is_calendar_date("03/15/2024") is True
    assert is_calendar_date("3/15/24") is True
    assert is_calendar_date("March 15, 2024") is False  # written form not whitelisted


def test_tax_form_recognition() -> None:
    assert is_tax_form("1099-NEC") is True
    assert is_tax_form("W-2") is True
    assert is_tax_form("1040") is True
    assert is_tax_form("1065") is True
    assert is_tax_form("8949") is True
    assert is_tax_form("1099") is False    # bare prefix, ambiguous
    assert is_tax_form("random") is False


def test_apply_whitelists_drops_currency() -> None:
    text = "Total: $1,234.56 paid."
    spans = [EntitySpan(entity_type="DATE_TIME", start=7, end=16, score=0.7)]
    kept = apply_whitelists(text, spans)
    assert kept == []


def test_apply_whitelists_drops_iso_date() -> None:
    text = "Posted 2024-03-15 to AR."
    spans = [EntitySpan(entity_type="DATE_TIME", start=7, end=17, score=0.8)]
    kept = apply_whitelists(text, spans)
    assert kept == []


def test_apply_whitelists_drops_tax_form() -> None:
    text = "Filed 1099-NEC for the contractor."
    # Even if some recognizer mistakenly flagged "1099-NEC" as US_SSN-shaped,
    # the whitelist suppresses it.
    spans = [EntitySpan(entity_type="US_SSN", start=6, end=14, score=0.5)]
    kept = apply_whitelists(text, spans)
    assert kept == []


def test_apply_whitelists_preserves_real_pii() -> None:
    text = "Email jane.doe@example.com about the 2024-03-15 close."
    spans = [
        EntitySpan(entity_type="EMAIL_ADDRESS", start=6, end=26, score=0.95),
        EntitySpan(entity_type="DATE_TIME", start=37, end=47, score=0.8),
    ]
    kept = apply_whitelists(text, spans)
    # Email kept, ISO date dropped.
    assert len(kept) == 1
    assert kept[0].entity_type == "EMAIL_ADDRESS"


@requires_model
def test_amounts_not_redacted_in_redact_endpoint(client) -> None:  # type: ignore[no-untyped-def]
    text = "Email jane.doe@example.com about the $1,234.56 invoice posted 2024-03-15."
    r = client.post("/redact", json={"text": text})
    body = r.json()
    # The email must be tokenized, but the amount and ISO date must pass through.
    assert "jane.doe@example.com" not in body["redacted_text"]
    assert "$1,234.56" in body["redacted_text"]
    assert "2024-03-15" in body["redacted_text"]


@requires_model
def test_tax_form_not_redacted(client) -> None:  # type: ignore[no-untyped-def]
    text = "The 1099-NEC was filed for Jane Doe last quarter."
    r = client.post("/redact", json={"text": text})
    body = r.json()
    assert "1099-NEC" in body["redacted_text"]
