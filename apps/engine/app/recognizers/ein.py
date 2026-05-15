"""US Employer Identification Number (EIN).

Format: two digits, hyphen, seven digits (`XX-XXXXXXX`). The IRS issues
EINs and the leading two-digit prefix maps to the issuing campus. Without
contextual cues this regex matches phone-system shortcodes and other
2-7-digit patterns, so context boosts confidence.
"""

from __future__ import annotations

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "US_EIN"

# Valid IRS-issued EIN prefixes (last updated by IRS in 2023). EINs whose
# first two digits are not in this set are extremely likely false positives.
# Source: IRS — How EINs are Assigned and Valid EIN Prefixes.
VALID_PREFIXES: frozenset[str] = frozenset(
    {
        "01", "02", "03", "04", "05", "06", "10", "11", "12", "13", "14", "15", "16",
        "20", "21", "22", "23", "24", "25", "26", "27",
        "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
        "40", "41", "42", "43", "44", "45", "46", "47", "48",
        "50", "51", "52", "53", "54", "55", "56", "57", "58", "59",
        "60", "61", "62", "63", "64", "65", "66", "67", "68",
        "71", "72", "73", "74", "75", "76", "77",
        "80", "81", "82", "83", "84", "85", "86", "87", "88",
        "90", "91", "92", "93", "94", "95", "98", "99",
    }
)


class VsUsEinRecognizer(PatternRecognizer):
    PATTERNS = (
        Pattern(name="ein_hyphenated", regex=r"\b\d{2}-\d{7}\b", score=0.6),
    )
    CONTEXT = (
        "ein",
        "employer id",
        "employer identification",
        "federal id",
        "fein",
        "tax id",
        "taxpayer id",
        "tin",
    )

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=list(self.CONTEXT),
            supported_language=supported_language,
        )

    def validate_result(self, pattern_text: str) -> bool:
        """Reject EIN-shaped strings whose prefix isn't IRS-valid.

        Drops a large class of false positives (date-of-birth fragments,
        formatted phone area codes) without hand-tuning context cues.
        """
        prefix = pattern_text[:2]
        return prefix in VALID_PREFIXES
