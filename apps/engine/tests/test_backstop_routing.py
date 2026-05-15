from __future__ import annotations

import pytest

from app.backstops.routing import RoutingBackstop

bs = RoutingBackstop()


def _hits(text: str) -> list[tuple[int, int]]:
    return [(h.start, h.end) for h in bs.find(text)]


# Public, checksum-valid ABA routings (issuing Federal Reserve banks).
# These are real numbers but bear no individual identity.
VALID = [
    "011000015",  # FRB Boston
    "021000021",  # FRB New York / Chase
    "121000358",  # FRB San Francisco
    "322271627",  # Chase, San Francisco
    "111000038",  # FRB Dallas / Bank of America TX
    "031000053",  # FRB Philadelphia
    "041000014",  # FRB Cleveland
    "051000017",  # FRB Richmond
    "061000146",  # FRB Atlanta
    "071000013",  # FRB Chicago
    "081000045",  # FRB St. Louis
    "091000019",  # FRB Minneapolis
    "101000048",  # FRB Kansas City
    "122000247",  # Wells Fargo
    "256074974",  # Navy Federal
    "271070801",  # Old Kent Bank
    "121042882",  # Wells Fargo San Francisco
    "067092022",  # Chase Florida
    "044000037",  # Huntington Ohio
    "075000019",  # M&I Marshall & Ilsley
]


@pytest.mark.parametrize("aba", VALID)
def test_routing_positive_variants(aba: str) -> None:
    text = f"Wire to routing {aba} on file."
    assert len(_hits(text)) == 1


@pytest.mark.parametrize(
    "text",
    [
        "Reference 000000000 (degenerate).",        # excluded explicitly
        "Reference 123456789 (no checksum).",
        "Reference 999999999 (no checksum).",
        "Eight 01100001 (too short).",
        "Ten  0110000150 (too long, no boundary at the position).",
        "Hyphenated 011-000-015 (not 9-digit block).",
        "Spaced 011 000 015 (not 9-digit block).",
    ],
)
def test_routing_negative_variants(text: str) -> None:
    assert _hits(text) == []
