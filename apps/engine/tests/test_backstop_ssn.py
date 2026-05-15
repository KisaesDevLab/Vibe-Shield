from __future__ import annotations

import pytest

from app.backstops.ssn import SsnBackstop

bs = SsnBackstop()


def _hits(text: str) -> list[tuple[int, int]]:
    return [(h.start, h.end) for h in bs.find(text)]


@pytest.mark.parametrize(
    "text",
    [
        "SSN 234-56-7890 was reported.",                # canonical hyphen
        "Plain 234 56 7890 elsewhere.",                  # spaces
        "Concatenated 234567890 inline.",                # no separator
        "Mixed 234-56 7890 form.",                       # hyphen + space
        "Trailing 234-56-7890,",                         # comma after
        "Bracketed (234-56-7890)",                       # parens
        "Newline before\n234-56-7890\nafter.",           # multi-line
        "Multiple: 234-56-7890 and 345-67-8901 here.",   # two SSNs
        "Tab\t234-56-7890\there.",                       # tabs around
        "Sentence end. 345-67-8901.",                    # sentence boundary
    ],
)
def test_ssn_positive_variants(text: str) -> None:
    assert len(_hits(text)) >= 1


@pytest.mark.parametrize(
    "text",
    [
        "Reserved 000-12-3456 invalid.",                  # 000 prefix
        "Reserved 666-12-3456 invalid.",                  # 666 prefix
        "Reserved 900-12-3456 invalid.",                  # 9xx prefix
        "Reserved 987-12-3456 invalid.",                  # 9xx prefix
        "Middle 123-00-6789 invalid.",                    # middle 00
        "Serial 123-45-0000 invalid.",                    # serial 0000
        "Too short 234-56-789 here.",                     # 3 digits at end
        "Too long 234-56-78901 here.",                    # 5 digits at end
        "Letters in the middle 234-AB-7890 here.",        # non-digit
        "Embedded5234-56-7890 fused-left.",               # no word boundary left
    ],
)
def test_ssn_negative_variants(text: str) -> None:
    assert _hits(text) == []


def test_ssn_dedupes_against_self() -> None:
    # Each occurrence is a separate hit; we don't dedupe at backstop level.
    text = "234-56-7890 and 234-56-7890 again."
    hits = bs.find(text)
    assert len(hits) == 2
