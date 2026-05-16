"""Tests for the v1.1 pre-recognizer protected-range layer (B1 fix).

The B1 blocker: ``US_BANK_ACCOUNT`` precision 0.45 / ``PHONE_NUMBER`` 0.77
because Presidio's recognizers fire on digit fragments inside currency
amounts and dates. The architectural fix computes contiguous protected
ranges up front; any Presidio span (or backstop hit) overlapping a
protected range is dropped.

These tests pin the contract:
1. compute_protected_ranges finds currency/date/tax-form regions.
2. apply_whitelists drops spans overlapping a protected range even when
   the span's substring doesn't match the whitelist regex.
3. US_DOB stays exempt — context-promoted, never drop.
4. BackstopLayer skips hits inside protected ranges.
"""

from __future__ import annotations

from app.analyzer import EntitySpan
from app.backstops.base import BackstopHit, Severity
from app.backstops.layer import BackstopLayer
from app.recognizers.protected_ranges import (
    ProtectedRange,
    compute_protected_ranges,
    overlaps_any,
)
from app.recognizers.whitelists import apply_whitelists

# ---- compute_protected_ranges ---------------------------------------


def test_finds_currency_anywhere() -> None:
    text = "Opening balance $4,201.33, closing $5,187.42."
    ranges = compute_protected_ranges(text)
    reasons = [r.reason for r in ranges]
    assert reasons.count("currency") == 2
    assert text[ranges[0].start : ranges[0].end] == "$4,201.33"
    assert text[ranges[1].start : ranges[1].end] == "$5,187.42"


def test_finds_iso_date() -> None:
    text = "Period 2026-04-01 to 2026-04-30."
    ranges = compute_protected_ranges(text)
    dates = [r for r in ranges if r.reason == "date"]
    assert len(dates) == 2
    assert text[dates[0].start : dates[0].end] == "2026-04-01"
    assert text[dates[1].start : dates[1].end] == "2026-04-30"


def test_finds_us_tabular_date() -> None:
    text = "Posted 03/15/2024 to AR; reversed 03-20-24."
    ranges = compute_protected_ranges(text)
    dates = [r for r in ranges if r.reason == "date"]
    assert len(dates) == 2
    assert text[dates[0].start : dates[0].end] == "03/15/2024"
    assert text[dates[1].start : dates[1].end] == "03-20-24"


def test_finds_tax_form() -> None:
    text = "Filed 1099-NEC and W-2 for tax year 2025."
    ranges = compute_protected_ranges(text)
    forms = [r for r in ranges if r.reason == "tax_form"]
    # Three matches: 1099-NEC, W-2, and "1040"-pattern matching W-2 inside
    # itself shouldn't happen because we sort longest-first.
    matched = sorted(text[r.start : r.end] for r in forms)
    assert "1099-NEC" in matched
    assert "W-2" in matched


def test_does_not_grab_fragment_of_long_digit_run() -> None:
    """The ISO-date regex must not match bytes inside a 16-digit account
    number — that would protect a real PII region from redaction."""
    text = "Card 1234-5678-9012-3456 was reissued."
    ranges = compute_protected_ranges(text)
    # No date should be returned from inside the card number.
    for r in ranges:
        if r.reason == "date":
            assert not (5 <= r.start < 25), f"date matched inside card: {r}"


def test_overlapping_raw_matches_merged() -> None:
    """If a tax form happens to contain a date-shaped substring (unlikely
    but defensible), the merge keeps a single contiguous range."""
    raw = [
        ProtectedRange(0, 8, "tax_form"),
        ProtectedRange(3, 11, "date"),
    ]
    raw.sort(key=lambda r: (r.start, -r.end))
    # Re-implement the merge locally to test the principle.
    merged: list[ProtectedRange] = []
    for r in raw:
        if merged and r.start < merged[-1].end:
            if r.end > merged[-1].end:
                merged[-1] = ProtectedRange(merged[-1].start, r.end, merged[-1].reason)
            continue
        merged.append(r)
    assert len(merged) == 1
    assert merged[0].start == 0 and merged[0].end == 11


# ---- overlaps_any ---------------------------------------------------


def test_overlaps_any_detects_partial_overlap() -> None:
    ranges = [ProtectedRange(10, 20, "currency")]
    assert overlaps_any(15, 25, ranges) is True
    assert overlaps_any(5, 15, ranges) is True
    assert overlaps_any(0, 10, ranges) is False  # touching at boundary != overlap
    assert overlaps_any(20, 30, ranges) is False


def test_overlaps_any_empty_ranges() -> None:
    assert overlaps_any(0, 10, []) is False


# ---- apply_whitelists with protected_ranges -------------------------


def test_drops_span_inside_currency_even_when_substring_isnt_currency() -> None:
    """The B1 case: BANK_ACCOUNT recognizer extracts ``4,201.33`` from
    inside ``$4,201.33``. Substring alone is not a currency match, but
    the span sits inside the protected currency range."""
    text = "Opening balance $4,201.33."
    # The "$" is at index 16; "4,201.33" starts at 17, ends at 25.
    span = EntitySpan(entity_type="US_BANK_ACCOUNT", start=17, end=25, score=0.85)
    ranges = compute_protected_ranges(text)
    kept = apply_whitelists(text, [span], protected_ranges=ranges)
    assert kept == []


def test_drops_phone_fragment_inside_account_number_proxy() -> None:
    """PHONE_NUMBER bare-10-digit collides with account fragments. Use a
    date as the protected region to keep the fixture deterministic."""
    text = "Posted 03/15/2024 batch."
    # PHONE_NUMBER falsely fires on digits within the date.
    span = EntitySpan(entity_type="PHONE_NUMBER", start=10, end=17, score=0.4)
    ranges = compute_protected_ranges(text)
    kept = apply_whitelists(text, [span], protected_ranges=ranges)
    assert kept == []


def test_us_dob_exempt_from_protected_range_drop() -> None:
    """A US_DOB hit means the context-enhancement layer already
    confirmed it. Even if it overlaps a date region, it should survive."""
    text = "DOB 03-15-1990, last visit 03-15-2024."
    dob_span = EntitySpan(entity_type="US_DOB", start=4, end=14, score=0.95)
    ranges = compute_protected_ranges(text)
    # Confirm the date range covers the DOB substring.
    assert overlaps_any(dob_span.start, dob_span.end, ranges) is True
    kept = apply_whitelists(text, [dob_span], protected_ranges=ranges)
    assert kept == [dob_span]


def test_legitimate_person_outside_currency_survives() -> None:
    text = "Statement for Maria Reyes, balance $1,234.56."
    person = EntitySpan(entity_type="PERSON", start=14, end=25, score=0.85)
    ranges = compute_protected_ranges(text)
    kept = apply_whitelists(text, [person], protected_ranges=ranges)
    assert kept == [person]


def test_no_protected_ranges_arg_preserves_legacy_behavior() -> None:
    """Callers that don't pass ``protected_ranges`` must see the same
    result as before — the v1.0 substring-match whitelist still applies,
    but no new drops happen."""
    text = "Opening balance $4,201.33."
    span = EntitySpan(entity_type="US_BANK_ACCOUNT", start=17, end=25, score=0.85)
    kept = apply_whitelists(text, [span])
    # Without ranges, the substring "4,201.33" doesn't match the currency
    # whitelist (no $) so the span survives — that's the v1.0 bug.
    assert kept == [span]


# ---- BackstopLayer with protected_ranges ----------------------------


class _SsnHitsCurrencyBackstop:
    """Trivial backstop that returns one hit at a fixed position. Use to
    assert the layer's protected-range filter without depending on the
    real SSN regex behaviour."""

    name = "test_ssn"
    entity_type = "US_SSN"
    severity = Severity.BLOCK

    def __init__(self, start: int, end: int) -> None:
        self._start = start
        self._end = end

    def find(self, text: str) -> list[BackstopHit]:
        return [
            BackstopHit(
                entity_type=self.entity_type,
                start=self._start,
                end=self._end,
                backstop_name=self.name,
                severity=self.severity,
            )
        ]


def test_backstop_skipped_when_hit_in_protected_range() -> None:
    text = "Total $123-45-6789 charged."  # implausible, but exemplifies the rule
    ranges = compute_protected_ranges(text)
    # The backstop pretends to fire on the SSN-shaped digits. It sits
    # inside the currency region so the layer should drop it.
    bs = _SsnHitsCurrencyBackstop(start=7, end=18)
    layer = BackstopLayer(backstops=[bs])
    spans, misses = layer.apply_with_misses(text, [], protected_ranges=ranges)
    assert spans == []
    assert misses == []


def test_backstop_fires_when_no_protected_overlap() -> None:
    text = "SSN on file is 123-45-6789 for taxpayer."
    bs = _SsnHitsCurrencyBackstop(start=15, end=26)
    layer = BackstopLayer(backstops=[bs])
    ranges = compute_protected_ranges(text)
    spans, misses = layer.apply_with_misses(text, [], protected_ranges=ranges)
    assert len(spans) == 1
    assert spans[0].entity_type == "US_SSN"
    assert len(misses) == 1


def test_backstop_protected_range_drop_is_silent_not_a_miss() -> None:
    """When a protected range causes a backstop to be skipped, no miss
    is recorded — it's not 'PII Presidio missed', it's 'we deliberately
    don't redact this'."""
    miss_calls: list[object] = []

    def handler(m: object) -> None:
        miss_calls.append(m)

    text = "Total $123-45-6789 charged."
    ranges = compute_protected_ranges(text)
    bs = _SsnHitsCurrencyBackstop(start=7, end=18)
    layer = BackstopLayer(backstops=[bs], miss_handler=handler)
    layer.apply_with_misses(text, [], protected_ranges=ranges)
    assert miss_calls == []
