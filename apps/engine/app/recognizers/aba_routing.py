"""US bank ABA routing number.

9 digits with a checksum: ``(3a + 7b + c + 3d + 7e + f + 3g + 7h + i) mod 10 == 0``
where each letter is one digit (left to right). The checksum is the
defining test — without it, every 9-digit run becomes a false positive.

Source: ABA Routing Number Policy (1910, updated 2016).
"""

from __future__ import annotations

import re

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "US_BANK_ROUTING"


def aba_checksum_valid(digits: str) -> bool:
    if len(digits) != 9 or not digits.isdigit():
        return False
    d = [int(c) for c in digits]
    total = (
        3 * d[0]
        + 7 * d[1]
        + 1 * d[2]
        + 3 * d[3]
        + 7 * d[4]
        + 1 * d[5]
        + 3 * d[6]
        + 7 * d[7]
        + 1 * d[8]
    )
    return total % 10 == 0


class VsUsBankRoutingRecognizer(PatternRecognizer):
    # Match 9 digits as a single unbroken run. We deliberately do NOT match
    # space- or hyphen-separated variants — banks always print routings as a
    # 9-digit block. Splitting would invite false positives on phone-shaped
    # input.
    PATTERNS = (
        Pattern(name="aba_9digit", regex=r"\b\d{9}\b", score=0.45),
    )
    CONTEXT = (
        "routing",
        "aba",
        "rtn",
        "ach",
        "wire",
        "bank routing",
        "transit",
    )

    _DIGITS = re.compile(r"\d")

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=list(self.CONTEXT),
            supported_language=supported_language,
        )

    def validate_result(self, pattern_text: str) -> bool:
        digits = "".join(self._DIGITS.findall(pattern_text))
        return aba_checksum_valid(digits)
