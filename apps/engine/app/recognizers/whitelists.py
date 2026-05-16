"""Whitelist filter — values that must always pass through unchanged.

BUILD_PLAN Phase 3 requires three explicit whitelists:

1. **Currency amounts** — transactions are unusable without dollar values.
2. **Calendar dates** — posting/transaction dates are operational data,
   not PII. (DOBs are caught separately by ``US_DOB``; they pass through
   the whitelist because a same-shape date is ambiguous without context,
   and the DOB recognizer's context cues already promoted true DOBs.)
3. **Tax-form numbers** — "1099-NEC", "W-2", "1040" etc. are document
   identifiers, not PII.

The filter runs *after* Presidio analysis, dropping any span whose text
matches a whitelist pattern. It does not modify spans; it only suppresses
them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TYPE_CHECKING

from app.analyzer import EntitySpan

if TYPE_CHECKING:
    from app.recognizers.protected_ranges import ProtectedRange

# Currency. Match $ followed by digits with optional thousands separators
# and optional decimal; minus may precede or follow $.
_CURRENCY_RE = re.compile(
    r"""
    ^\s*
    (?:
        -?\$\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?    # $1,234.56 or -$50.00
      | -?\$\s?-?\d+(?:\.\d{1,2})?                   # $1234.56
      | -?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*USD     # 1,234.56 USD
    )
    \s*$
    """,
    re.VERBOSE,
)

# ISO-8601 dates and common US tabular date formats. We do NOT whitelist
# dates that the DOB recognizer already promoted — those carry context
# cues and arrive here as US_DOB entities.
_ISO_DATE_RE = re.compile(r"^\s*\d{4}-\d{2}-\d{2}\s*$")
_US_DATE_RE = re.compile(r"^\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s*$")

# Tax-form numbers. Documented exhaustively; new IRS forms can be added
# without retraining anything.
TAX_FORM_NUMBERS: frozenset[str] = frozenset(
    {
        # 1099 series
        "1099-NEC", "1099-MISC", "1099-K", "1099-INT", "1099-DIV", "1099-R",
        "1099-G", "1099-B", "1099-S", "1099-C", "1099-A", "1099-Q", "1099-SA",
        # W series
        "W-2", "W-2G", "W-3", "W-4", "W-7", "W-8BEN", "W-8ECI", "W-9",
        # 1040 series
        "1040", "1040-SR", "1040-NR", "1040-ES", "1040-X", "1040-V",
        # Business returns
        "1065", "1120", "1120-S", "1120-C",
        # Employment
        "940", "941", "943", "944", "945",
        # Estate / trust
        "706", "709", "1041",
        # Information returns / schedules
        "5471", "5472", "5500", "8606", "8821", "8832", "8879", "8949",
        "1098", "1098-E", "1098-T",
    }
)

_TAX_FORM_RE = re.compile(
    r"^\s*(?:" + "|".join(re.escape(s) for s in TAX_FORM_NUMBERS) + r")\s*$",
    re.IGNORECASE,
)


def is_currency(text: str) -> bool:
    return bool(_CURRENCY_RE.match(text))


def is_calendar_date(text: str) -> bool:
    """A bare date that should pass through. DOBs (with context) won't
    arrive here because they're tagged ``US_DOB``, not ``DATE_TIME``."""
    return bool(_ISO_DATE_RE.match(text) or _US_DATE_RE.match(text))


def is_tax_form(text: str) -> bool:
    return bool(_TAX_FORM_RE.match(text))


# Form-number prefixes that, when followed by a hyphen and known suffix,
# extend into a tax form (e.g., "1099" → "1099-NEC"). When Presidio only
# tags the prefix, we still suppress because the prefix sits inside a tax
# form pattern that as a whole shouldn't be redacted.
_TAX_FORM_PREFIX_RE = re.compile(
    r"^\s*(?:1099|1098|W|1040)\s*$",
    re.IGNORECASE,
)
_TAX_FORM_SUFFIX_AT = re.compile(
    r"^-(?:NEC|MISC|K|INT|DIV|R|G|B|S|C|A|Q|SA|2|2G|3|4|7|8BEN|8ECI|9|SR|NR|ES|X|V|E|T)\b",
    re.IGNORECASE,
)


def _is_tax_form_prefix(text: str, full: str, end: int) -> bool:
    """Check whether ``text`` is the prefix portion of a longer tax form
    that begins at ``end`` in ``full``."""
    if not _TAX_FORM_PREFIX_RE.match(text):
        return False
    return bool(_TAX_FORM_SUFFIX_AT.match(full[end:]))


def apply_whitelists(
    text: str,
    spans: Iterable[EntitySpan],
    protected_ranges: list[ProtectedRange] | None = None,
) -> list[EntitySpan]:
    """Drop any span whose substring matches the whitelist OR overlaps a
    pre-computed protected range.

    Suppression is unconditional on entity type — if the *text* matches a
    whitelist, the span is dropped no matter which recognizer flagged it.
    This matters because Presidio's recognizers cross-match: ``"1099-NEC"``
    can come back as ``DATE_TIME`` from one recognizer and ``US_BANK_ACCOUNT``
    from another. Both should be suppressed.

    ``protected_ranges`` (v1.1, B1 fix) is the over-redaction prevention
    layer for spans that fall *inside* a known-non-PII region but whose
    own substring doesn't match the whitelist regex — e.g., the digit
    run ``4,201.33`` that BANK_ACCOUNT extracts from inside ``$4,201.33``.
    Any overlap with a protected range drops the span.

    ``US_DOB`` is explicitly exempt from both filters — DOBs only fire
    when the context-enhancement layer promotes them past the score
    threshold, so a US_DOB hit means the surrounding cue confirmed it's
    a birth date.
    """
    ranges = protected_ranges or []
    kept: list[EntitySpan] = []
    for span in spans:
        substr = text[span.start : span.end]
        if span.entity_type == "US_DOB":
            kept.append(span)
            continue
        if is_tax_form(substr):
            continue
        if _is_tax_form_prefix(substr, text, span.end):
            continue
        if is_calendar_date(substr):
            continue
        if is_currency(substr):
            continue
        if ranges and _overlaps_any_range(span.start, span.end, ranges):
            continue
        kept.append(span)
    return kept


def _overlaps_any_range(start: int, end: int, ranges: list[ProtectedRange]) -> bool:
    """Inline copy of ``protected_ranges.overlaps_any`` to avoid a
    runtime import cycle (whitelists.py is imported by analyzer.py and
    by protected_ranges.py)."""
    for r in ranges:
        if not (end <= r.start or r.end <= start):
            return True
    return False
