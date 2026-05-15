"""Individual Taxpayer Identification Number (ITIN).

Format: ``9XX-7Y-XXXX`` or ``9XX-8Y-XXXX`` where the second group's first
digit is 7 or 8 (the IRS reserves 70-88 and 90-92 / 94-99 for ITINs;
50-65, 70-88, 90-92, 94-99 since 2012 expansion).

Source: IRS Publication 1915 (ITIN Operations).
"""

from __future__ import annotations

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "US_ITIN"


def _itin_middle_valid(middle: str) -> bool:
    """The IRS-assigned ITIN middle-group ranges."""
    if len(middle) != 2 or not middle.isdigit():
        return False
    n = int(middle)
    return 50 <= n <= 65 or 70 <= n <= 88 or 90 <= n <= 92 or 94 <= n <= 99


class VsUsItinRecognizer(PatternRecognizer):
    PATTERNS = (
        Pattern(
            name="itin_hyphenated",
            regex=r"\b9\d{2}-\d{2}-\d{4}\b",
            score=0.7,
        ),
        Pattern(
            name="itin_spaced",
            regex=r"\b9\d{2}\s\d{2}\s\d{4}\b",
            score=0.6,
        ),
        Pattern(
            name="itin_compact",
            regex=r"\b9\d{8}\b",
            score=0.4,
        ),
    )
    CONTEXT = (
        "itin",
        "individual taxpayer",
        "taxpayer id",
        "tax id number",
        "irs id",
    )

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=list(self.CONTEXT),
            supported_language=supported_language,
        )

    def validate_result(self, pattern_text: str) -> bool:
        digits = "".join(c for c in pattern_text if c.isdigit())
        if len(digits) != 9 or not digits.startswith("9"):
            return False
        return _itin_middle_valid(digits[3:5])
