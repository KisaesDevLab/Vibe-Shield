"""Tests for cross-type span deconfliction (B1 fix, second half)."""

from __future__ import annotations

from app.analyzer import EntitySpan
from app.recognizers.deconflict import deconflict_overlapping_spans


def _span(et: str, start: int, end: int, score: float = 0.5) -> EntitySpan:
    return EntitySpan(entity_type=et, start=start, end=end, score=score)


def test_routing_wins_over_account_alias_at_same_region() -> None:
    """The B1 case: routing number is double-tagged. ROUTING is tier A,
    BANK_ACCOUNT is tier B, BANK_NUMBER and PHONE are lower."""
    spans = [
        _span("US_BANK_ROUTING", 59, 68, 1.00),
        _span("US_DRIVER_LICENSE", 59, 68, 1.00),
        _span("PHONE_NUMBER", 59, 68, 0.40),
        _span("US_BANK_NUMBER", 59, 68, 0.40),
        _span("US_BANK_ACCOUNT", 59, 68, 0.40),
    ]
    out = deconflict_overlapping_spans(spans)
    types = [s.entity_type for s in out]
    assert types == ["US_BANK_ROUTING"]


def test_ein_wins_over_phone_alias() -> None:
    spans = [
        _span("US_EIN", 31, 41, 1.00),
        _span("PHONE_NUMBER", 31, 41, 0.40),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["US_EIN"]


def test_ein_wins_over_drivers_license_subset() -> None:
    """DRIVER_LICENSE [34:41] is contained in EIN [31:41]. EIN wins."""
    spans = [
        _span("US_EIN", 31, 41, 1.00),
        _span("US_DRIVER_LICENSE", 34, 41, 1.00),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["US_EIN"]


def test_bank_account_wins_over_drivers_license() -> None:
    """Presidio's DRIVER_LICENSE recognizer fires on any 7-21 digit run
    with score 1.00 — it's promiscuous. BANK_ACCOUNT is tier B, DL is
    tier D, so BANK_ACCOUNT wins regardless of score. This preserves
    the recognizer-test contract (DDA contexts must produce
    BANK_ACCOUNT, not DL)."""
    spans = [
        _span("US_DRIVER_LICENSE", 37, 49, 1.00),
        _span("US_BANK_ACCOUNT", 37, 49, 0.40),
        _span("US_BANK_NUMBER", 37, 49, 0.40),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["US_BANK_ACCOUNT"]


def test_phone_wins_over_date_time() -> None:
    """DATE_TIME fires on dotted phone formats like 312.555.0166 with
    score 0.85. Without deconfliction, PHONE_NUMBER (score 0.40) loses
    on score. Tier-based priority puts DATE_TIME in tier D so PHONE
    wins — preserves the synthetic-fixture contract."""
    spans = [
        _span("DATE_TIME", 21, 33, 0.85),
        _span("PHONE_NUMBER", 21, 33, 0.40),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["PHONE_NUMBER"]


def test_non_overlapping_spans_all_survive() -> None:
    spans = [
        _span("PERSON", 0, 10, 0.85),
        _span("US_SSN", 20, 31, 0.85),
        _span("EMAIL_ADDRESS", 40, 60, 1.00),
    ]
    out = deconflict_overlapping_spans(spans)
    assert len(out) == 3


def test_same_type_overlap_kept() -> None:
    """Two PERSON spans overlapping (different start/end) are both kept
    — same-type overlaps are not deduped here."""
    spans = [
        _span("PERSON", 0, 10, 0.85),
        _span("PERSON", 5, 15, 0.85),
    ]
    out = deconflict_overlapping_spans(spans)
    assert len(out) == 2


def test_us_dob_exempt_from_being_dropped() -> None:
    """Even if a higher-priority span overlaps a US_DOB, the DOB stays
    — context promotion already vetted it."""
    spans = [
        _span("US_DOB", 4, 14, 0.95),
        _span("US_BANK_ROUTING", 4, 14, 1.00),  # implausible but tests the rule
    ]
    out = deconflict_overlapping_spans(spans)
    types = sorted(s.entity_type for s in out)
    assert "US_DOB" in types
    # ROUTING is also kept (DOB doesn't dominate others, just isn't dominated)
    assert "US_BANK_ROUTING" in types


def test_au_tfn_dropped_against_us_routing() -> None:
    """Australian TFN is tier D — never wins against a US tier-A type."""
    spans = [
        _span("AU_TFN", 0, 9, 1.00),
        _span("US_BANK_ROUTING", 0, 9, 1.00),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["US_BANK_ROUTING"]


def test_input_order_preserved_for_kept_spans() -> None:
    spans = [
        _span("EMAIL_ADDRESS", 100, 120, 1.00),
        _span("PERSON", 0, 10, 0.85),
        _span("US_SSN", 20, 31, 0.85),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["EMAIL_ADDRESS", "PERSON", "US_SSN"]


def test_empty_input() -> None:
    assert deconflict_overlapping_spans([]) == []


def test_unknown_entity_type_uses_default_priority() -> None:
    """A type not in the priority table is mid-tier (50). It's dropped
    against tier A (90) but wins against tier D (10)."""
    spans = [
        _span("CUSTOM_TYPE_XYZ", 0, 10, 0.5),
        _span("US_SSN", 0, 10, 0.85),
    ]
    out = deconflict_overlapping_spans(spans)
    assert [s.entity_type for s in out] == ["US_SSN"]

    spans2 = [
        _span("CUSTOM_TYPE_XYZ", 0, 10, 0.5),
        _span("AU_TFN", 0, 10, 1.00),
    ]
    out2 = deconflict_overlapping_spans(spans2)
    assert [s.entity_type for s in out2] == ["CUSTOM_TYPE_XYZ"]
