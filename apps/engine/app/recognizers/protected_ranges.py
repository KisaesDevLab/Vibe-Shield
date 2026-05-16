"""Pre-recognizer protected ranges.

Computes contiguous text regions that must NEVER be redacted because
they're known-non-PII patterns: currency amounts, calendar dates, and
tax-form numbers. The analyzer drops any Presidio span that overlaps
one of these ranges; the backstop layer skips them entirely.

Why pre-compute instead of post-filter substring-match? The B1 blocker:
``$4,201.33`` parses as a currency by ``apply_whitelists`` if Presidio
returns it whole, but ``US_BANK_ACCOUNT`` fires on the *digit run*
``4,201.33`` whose substring (no ``$``) doesn't match the currency
regex. Post-filter passes it through; the bank-account redaction wins.
A region-based filter drops any span overlapping the wider ``$4,201.33``
range and the false positive disappears.

Hard rule: this is over-redaction prevention. It MUST NOT make recall
regress. ``US_DOB`` is exempt from the overlap drop because DOBs only
fire when promoted past threshold by surrounding context cues — a hit
means the cue confirmed the date is a birth date.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.recognizers.whitelists import TAX_FORM_NUMBERS

# Currency anywhere in text. Captures $1,234.56 / $1234 / 1,234.56 USD,
# with optional leading minus. Greedy on the digit/comma/decimal run so
# we get the full ``$4,201.33`` rather than just ``$4``.
_CURRENCY_ANYWHERE_RE = re.compile(
    r"""
    (?:
        -?\$\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?       # $1,234.56 / -$50.00
      | -?\$\s?-?\d+(?:\.\d{1,2})?                       # $1234.56
      | (?<![\d.])-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\s*USD?\b  # 1,234.56 USD with thousands
      | (?<![\d.])-?\d+\.\d{2}\s*USD\b                   # 1234.56 USD (decimal-anchored)
    )
    """,
    re.VERBOSE,
)

# ISO-8601 dates and US tabular dates anywhere in text. Negative
# lookarounds keep us from grabbing a fragment of a longer digit run
# (e.g., the middle of a 16-digit account number).
_ISO_DATE_ANYWHERE_RE = re.compile(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)")
_US_DATE_ANYWHERE_RE = re.compile(r"(?<!\d)\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?!\d)")

# Tax-form numbers anywhere in text. Build from the canonical set in
# whitelists.py so adding a form there propagates here automatically.
# Sort longest-first so 1099-NEC matches before 1099.
_SORTED_TAX_FORMS = sorted(TAX_FORM_NUMBERS, key=len, reverse=True)
_TAX_FORM_ANYWHERE_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(s) for s in _SORTED_TAX_FORMS) + r")\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ProtectedRange:
    """An [start, end) text region that must not be redacted."""

    start: int
    end: int
    reason: str  # "currency" | "date" | "tax_form"


def compute_protected_ranges(text: str) -> list[ProtectedRange]:
    """Return non-overlapping protected ranges in ``text``, sorted by start.

    Overlapping raw matches (e.g., a date inside a tax-form-shaped string)
    are merged: the earliest-starting match wins, and any later match
    that starts before the prior match ends is dropped. This is a
    conservative posture — better to over-protect than to leave a
    fragment exposed.
    """
    raw: list[ProtectedRange] = []
    for m in _CURRENCY_ANYWHERE_RE.finditer(text):
        raw.append(ProtectedRange(m.start(), m.end(), "currency"))
    for m in _ISO_DATE_ANYWHERE_RE.finditer(text):
        raw.append(ProtectedRange(m.start(), m.end(), "date"))
    for m in _US_DATE_ANYWHERE_RE.finditer(text):
        raw.append(ProtectedRange(m.start(), m.end(), "date"))
    for m in _TAX_FORM_ANYWHERE_RE.finditer(text):
        raw.append(ProtectedRange(m.start(), m.end(), "tax_form"))
    raw.sort(key=lambda r: (r.start, -r.end))

    merged: list[ProtectedRange] = []
    for r in raw:
        if merged and r.start < merged[-1].end:
            # Extend the prior range if this one stretches further.
            if r.end > merged[-1].end:
                merged[-1] = ProtectedRange(merged[-1].start, r.end, merged[-1].reason)
            continue
        merged.append(r)
    return merged


def overlaps_any(start: int, end: int, ranges: list[ProtectedRange]) -> bool:
    """True if [start, end) touches any range in ``ranges`` by even one
    character. Per the B1 design decision: any overlap drops the span."""
    for r in ranges:
        if not (end <= r.start or r.end <= start):
            return True
    return False
