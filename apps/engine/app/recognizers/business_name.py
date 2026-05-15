"""Business / legal entity names tuned for CPA workflows.

Detects names that end with a corporate-form suffix. Presidio's default
ORGANIZATION recognizer (via spaCy NER) catches well-known company names
but misses small-business clients whose names only carry signal in the
suffix. Examples:

  "Acme Bookkeeping LLC"            → BUSINESS_NAME
  "Smith & Jones, P.C."             → BUSINESS_NAME
  "Riverside Holdings, Inc."        → BUSINESS_NAME
"""

from __future__ import annotations

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "BUSINESS_NAME"

# Suffixes are matched case-insensitively. Listed exhaustively rather than
# via abbreviation patterns because periods inside the suffix vary
# (P.C. / PC, L.L.P. / LLP) and false-positive risk on phrases like "Inc."
# inside larger words is low.
_SUFFIXES = (
    "LLC",
    "L.L.C.",
    "Inc",
    "Inc.",
    "Incorporated",
    "Corp",
    "Corp.",
    "Corporation",
    "Co",
    "Co.",
    "Company",
    "LP",
    "L.P.",
    "LLP",
    "L.L.P.",
    "PC",
    "P.C.",
    "PLLC",
    "P.L.L.C.",
    "Ltd",
    "Ltd.",
)


def _suffix_alt() -> str:
    return "|".join(s.replace(".", r"\.") for s in _SUFFIXES)


# A title-cased noun phrase (1-5 capitalized words, with optional & or
# commas) immediately followed by a corporate suffix.
#
# Presidio compiles regexes with re.IGNORECASE, which turns `[A-Z]` into a
# match for any letter. Wrap the leading letter in `(?-i:...)` to scope
# the case-insensitive flag off for that position only. Without this,
# every lowercase word would qualify as a "capitalized" start.
#
# Trailing `(?=\s|[,.;:!?)]|$)` replaces the bare `\b` so suffixes that
# legitimately end with a period (P.C., Inc., L.P.) still terminate
# cleanly — `\b` would not match after a period at end-of-string.
_NAME_RE = (
    r"\b(?:(?-i:[A-Z])[A-Za-z0-9']+(?:\s+(?:&|and))?\s*){1,5}"
    rf",?\s+(?:{_suffix_alt()})(?=\s|[,.;:!?)]|$)"
)


class VsBusinessNameRecognizer(PatternRecognizer):
    PATTERNS = (
        Pattern(
            name="business_suffix",
            regex=_NAME_RE,
            score=0.55,
        ),
    )

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=[],
            supported_language=supported_language,
        )
