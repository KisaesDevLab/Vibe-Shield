"""US Driver's License number.

State-issued DL formats vary widely. This recognizer combines per-state
patterns with a general fallback (alphanumeric block, 6-13 characters) and
relies on context cues. Per-state coverage is intentionally partial — we
focus on the highest-population states first; the fallback catches the
rest with lower confidence.

Sources: state DMV public format specifications; AAMVA Card Design
Specification (data element D20).
"""

from __future__ import annotations

import re

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "US_DRIVER_LICENSE"


# Per-state regexes. Key = USPS code, value = uppercase regex applied to
# normalized (uppercased, spaces stripped) license candidates.
STATE_PATTERNS: dict[str, re.Pattern[str]] = {
    "CA": re.compile(r"^[A-Z]\d{7}$"),
    "NY": re.compile(r"^(?:\d{9}|\d{8}|[A-Z]\d{7}|[A-Z]{2}\d{6})$"),
    "TX": re.compile(r"^\d{7,8}$"),
    "FL": re.compile(r"^[A-Z]\d{12}$"),
    "IL": re.compile(r"^[A-Z]\d{11,12}$"),
    "PA": re.compile(r"^\d{8}$"),
    "OH": re.compile(r"^[A-Z]{2}\d{6}$"),
    "GA": re.compile(r"^\d{7,9}$"),
    "NC": re.compile(r"^\d{1,12}$"),
    "MI": re.compile(r"^[A-Z]\d{12}$"),
    "NJ": re.compile(r"^[A-Z]\d{14}$"),
    "VA": re.compile(r"^[A-Z]\d{8,11}$"),
    # WA DLs are 12 chars: first 5 from last name (`*`-padded if shorter),
    # next 2 from initials, last 5 alphanumeric (DOB-derived + check).
    # Source: WA RCW 46.20.155.
    "WA": re.compile(r"^[A-Z*]{7}[A-Z\d*]{5}$"),
    "AZ": re.compile(r"^[A-Z]\d{8}$"),
    "MA": re.compile(r"^S\d{8}$"),
}


class VsUsDriversLicenseRecognizer(PatternRecognizer):
    # Conservative shape: 6-13 alnum chars, mixed-case allowed but at
    # least one digit to keep proper nouns out.
    PATTERNS = (
        Pattern(
            name="dl_alnum_block",
            regex=r"\b(?=[A-Z\d]{6,13}\b)(?=[A-Z\d]*\d)[A-Z\d]{6,13}\b",
            score=0.3,
        ),
    )
    CONTEXT = (
        "driver",
        "driver's license",
        "drivers license",
        "dl#",
        "dl no",
        "license no",
        "license number",
        "lic#",
        "lic no",
        "operator",
    )

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=list(self.CONTEXT),
            supported_language=supported_language,
        )

    def validate_result(self, pattern_text: str) -> bool | None:
        """Boost confidence only on state-pattern matches.

        - State-shape match → ``True`` (boost to 1.0; high confidence)
        - 6+ alphanumeric with ≥1 digit but no state match → ``None`` (no
          opinion, keep pattern base score, require context to survive)
        - Otherwise → ``False`` (reject)
        """
        token = pattern_text.upper().replace(" ", "").replace("-", "")
        if any(p.match(token) for p in STATE_PATTERNS.values()):
            return True
        if len(token) >= 6 and any(c.isdigit() for c in token):
            return None
        return False
