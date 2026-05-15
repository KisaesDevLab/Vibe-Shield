from __future__ import annotations

import pytest

from app.backstops.ein import EinBackstop

bs = EinBackstop()


def _hits(text: str) -> list[tuple[int, int]]:
    return [(h.start, h.end) for h in bs.find(text)]


@pytest.mark.parametrize(
    "text",
    [
        "EIN 12-3456789 on file.",
        "Federal ID 27-9999999 for the trust.",
        "Issued 33-1112222 at incorporation.",
        "Updated EIN: 45-6789012 last quarter.",
        "FEIN 52-1111111 in the binder.",
        "Tax ID 91-8765432 listed.",
        "Plain 84-2223333 in column B.",
        "EIN value 02-4567891.",
        "EIN 16-1112223;",
        "EIN 22-3334445 yesterday.",
        "EIN 38-9988776 was sent.",
        "Listed: 47-1234567 in the docs.",
        "EIN 55-7654321 on row 4.",
        "EIN 64-1010101 at the bottom.",
        "EIN 76-2020202 confirmed.",
        "EIN 81-3030303 today.",
    ],
)
def test_ein_positive_variants(text: str) -> None:
    assert len(_hits(text)) == 1


@pytest.mark.parametrize(
    "text",
    [
        "Reference 07-1234567 (invalid prefix).",          # 07 not in IRS list
        "Reference 17-1234567 (invalid prefix).",
        "Reference 18-1234567 (invalid prefix).",
        "Reference 19-1234567 (invalid prefix).",
        "Reference 28-1234567 (invalid prefix).",
        "Reference 29-1234567 (invalid prefix).",
        "Reference 49-1234567 (invalid prefix).",
        "Reference 69-1234567 (invalid prefix).",
        "Reference 89-1234567 (invalid prefix).",
        "Reference 96-1234567 (invalid prefix).",
        "Short 12-345678 not enough digits.",
        "Long 12-12345678 too many digits.",
        "Spaced 12 3456789 wrong separator.",
        "Slash 12/3456789 wrong separator.",
        "No hyphen 123456789 — would collide with phones / accounts.",
    ],
)
def test_ein_negative_variants(text: str) -> None:
    assert _hits(text) == []


def test_ein_count_in_table() -> None:
    # 5 distinct EINs in a tabular block.
    text = (
        "Row 1 EIN 12-1111111\n"
        "Row 2 EIN 27-2222222\n"
        "Row 3 EIN 38-3333333\n"
        "Row 4 EIN 45-4444444\n"
        "Row 5 EIN 52-5555555\n"
    )
    assert len(_hits(text)) == 5
