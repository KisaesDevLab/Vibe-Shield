from __future__ import annotations

import pytest

from app.backstops.phone import PhoneBackstop

bs = PhoneBackstop()


def _hits(text: str) -> list[tuple[int, int]]:
    return [(h.start, h.end) for h in bs.find(text)]


@pytest.mark.parametrize(
    "phone",
    [
        "+1 555 555 5555",
        "+1-555-555-5555",
        "+15555555555",
        "(555) 555-5555",
        "(555)555-5555",
        "555-555-5555",
        "555.555.5555",
        "555 555 5555",
        "(415) 555-0143",
        "212-555-0177",
        "646.555.0102",
        "+1 (415) 555-0188",
        "415-555-0143 ext 12",
        "415-555-0143 x 99",
        "415-555-0143 ext. 401",
        "(202) 555-0123",
        "703-555-0145",
        "(617) 555-0166",
        "+1.617.555.0166",
        "+1-617-555-0166",
    ],
)
def test_phone_positive(phone: str) -> None:
    text = f"Reach out at {phone} during business hours."
    assert len(_hits(text)) >= 1


@pytest.mark.parametrize(
    "text",
    [
        "Only 7 digits 555-1234 here.",                  # NANP requires area code
        "Short 555 5555 (8 digits).",
        "Letters 415-AB5-1234.",
        "Just digits 1234567 no separators.",
    ],
)
def test_phone_negative(text: str) -> None:
    assert _hits(text) == []


def test_phone_bare_10digit_is_match_by_design() -> None:
    # A bare 10-digit run is matched even without separators or context.
    # The backstop is deliberately permissive: phone vs. order-number is
    # ambiguous, and false-positive on order numbers is preferred to
    # leaking a phone past Presidio.
    hits = bs.find("Order #4155551234 inside a longer number, not bare.")
    assert len(hits) == 1
