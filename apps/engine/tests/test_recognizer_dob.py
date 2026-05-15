from __future__ import annotations

from app.recognizers.dob import generalize_to_year
from tests.conftest import requires_model


def test_generalize_to_year_unit() -> None:
    assert generalize_to_year("01/15/1985") == "1985"
    assert generalize_to_year("1985-07-04") == "1985"
    assert generalize_to_year("July 4, 1985") == "1985"
    # 2-digit YY is ambiguous; we return None rather than guess the century.
    assert generalize_to_year("1/15/85") is None
    assert generalize_to_year("no date here") is None


@requires_model
def test_dob_detected_with_context(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "DOB: 01/15/1985 on the engagement letter."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_DOB" in types


@requires_model
def test_dob_detected_written_form(client) -> None:  # type: ignore[no-untyped-def]
    r = client.post(
        "/analyze",
        json={"text": "His birthday is July 4, 1985 per the W-9."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_DOB" in types


@requires_model
def test_plain_date_not_flagged_as_dob(client) -> None:  # type: ignore[no-untyped-def]
    # A posting date without DOB context should not be a DOB. (DATE_TIME
    # may still detect it; this test specifically guards against US_DOB
    # spreading to operational dates.)
    r = client.post(
        "/analyze",
        json={"text": "Posted 03/15/2024 to the accounts receivable ledger."},
    )
    types = {s["entity_type"] for s in r.json()["results"]}
    assert "US_DOB" not in types
