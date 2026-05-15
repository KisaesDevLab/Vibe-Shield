"""US bank account number.

US accounts are typically 4-17 digits with no checksum. That makes them
indistinguishable from invoice numbers, order IDs, or any other tabular
integer — so we require a context cue ("Account #", "Acct", "DDA") within
the recognizer's context window. Without context the score is too low to
survive the analyzer's default 0.4 threshold.
"""

from __future__ import annotations

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "US_BANK_ACCOUNT"


class VsUsBankAccountRecognizer(PatternRecognizer):
    PATTERNS = (
        # Optional space/hyphen grouping for banks that print accounts as
        # "1234-5678-9012" or "1234 5678 9012". Total digits between 4 and 17.
        # Low base score: this pattern matches any tabular integer; only the
        # context-enhancement boost (when "Account #" / "Acct" / "DDA" is
        # near the match) should lift it above the analyzer threshold.
        Pattern(
            name="account_4to17",
            regex=r"\b\d(?:[\d\s-]{2,21}\d)\b",
            score=0.05,
        ),
    )
    CONTEXT = (
        "account",
        "acct",
        "acct#",
        "acct no",
        "account #",
        "account no",
        "account number",
        "dda",
        "checking",
        "savings",
        "deposit",
    )

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=list(self.CONTEXT),
            supported_language=supported_language,
        )

    def validate_result(self, pattern_text: str) -> bool | None:
        """Hard-reject below 4 or above 17 digits.

        Returns ``None`` (no opinion) for in-range candidates so Presidio
        keeps the pattern's base score rather than boosting to 1.0 — without
        a context cue the match must remain below the analyzer threshold.
        """
        digits = "".join(c for c in pattern_text if c.isdigit())
        if not (4 <= len(digits) <= 17):
            return False
        return None
