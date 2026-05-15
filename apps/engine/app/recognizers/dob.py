"""Date of birth.

Detected via shape (the same shape as any date) plus context cues like
"DOB", "date of birth", "born", "birthday". Without context this would
swallow every date in a document — useless for CPA workflows where
posting dates and transaction dates dominate.

A future policy option (Phase 6 — strict policy) generalizes detected
DOBs to year-only by calling :func:`generalize_to_year` on the matched
text before tokenization. Phase 3 only handles detection; the tokenizer
applies the generalization when its policy says so.
"""

from __future__ import annotations

import re

from presidio_analyzer import Pattern, PatternRecognizer

ENTITY = "US_DOB"

# Common US-style dates: MM/DD/YYYY, MM-DD-YYYY, M/D/YY, written months,
# and ISO YYYY-MM-DD. The recognizer relies on context to distinguish
# DOBs from other dates.
# Base scores are deliberately below the analyzer's default 0.4 threshold:
# a bare date is not PII. The Presidio context-enhancement layer adds ~0.35
# when a DOB context cue ("DOB", "born", "date of birth") sits near the
# match, which lifts the effective score above 0.4 and the date survives
# as a US_DOB. Without context, the date is dropped from the result set —
# transaction / posting dates are left alone.
_DATE_PATTERNS: tuple[Pattern, ...] = (
    Pattern(
        name="dob_numeric_slash",
        regex=r"\b(0?[1-9]|1[0-2])/(0?[1-9]|[12]\d|3[01])/(\d{2}|\d{4})\b",
        score=0.2,
    ),
    Pattern(
        name="dob_numeric_dash",
        regex=r"\b(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])-(\d{2}|\d{4})\b",
        score=0.2,
    ),
    Pattern(
        name="dob_iso",
        regex=r"\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b",
        score=0.15,
    ),
    Pattern(
        name="dob_written",
        regex=(
            r"\b(?:January|February|March|April|May|June|July|August|"
            r"September|October|November|December)\s+\d{1,2},?\s+(?:19|20)\d{2}\b"
        ),
        score=0.25,
    ),
)


class VsUsDateOfBirthRecognizer(PatternRecognizer):
    PATTERNS = _DATE_PATTERNS
    # Presidio's LemmaContextAwareEnhancer matches text tokens by lemma
    # within a 5-token window of the match. Multi-word phrases ("date of
    # birth", "born on") don't survive tokenization. The lemma of "Born"
    # is "bear", which collides with the unrelated noun — so we cue on
    # "birth" (single token, distinct lemma) and "dob" / "birthday"
    # instead, which catch the canonical CPA-form phrasings.
    CONTEXT = (
        "dob",
        "birthday",
        "birth",
        "birthdate",
        "born",
    )

    def __init__(self, supported_language: str = "en") -> None:
        super().__init__(
            supported_entity=ENTITY,
            patterns=list(self.PATTERNS),
            context=list(self.CONTEXT),
            supported_language=supported_language,
        )


_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\b")


def generalize_to_year(matched_text: str) -> str | None:
    """Reduce a detected DOB to its year, e.g. ``"1985"``.

    Returns ``None`` if no 4-digit year is present (2-digit YY dates are
    ambiguous between 1900s and 2000s — the caller decides whether to
    redact fully or apply a window heuristic).
    """
    m = _YEAR_RE.search(matched_text)
    return m.group(1) if m else None
