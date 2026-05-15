"""Backstop base types.

A backstop is a deterministic regex (with optional validation) that runs
*after* Presidio. Its purpose is to catch high-confidence PII patterns the
NER pipeline missed — e.g., an SSN-shaped string that spaCy didn't tag
because the surrounding context wasn't recognizable English.

Backstop hits that overlap an existing Presidio span are not "misses" —
they're confirmations. Only non-overlapping hits trigger the miss log.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol


class Severity(StrEnum):
    """Severity controls how a backstop *miss* (PII Presidio didn't catch)
    is escalated. Detection of the PII itself always happens; severity is
    about the log/alert path.
    """

    BLOCK = "block"  # Urgent: a high-value PII type leaked past NER. Page/page-equivalent.
    WARN = "warn"    # Notable: should investigate. Daily digest.
    ALLOW = "allow"  # Informational: known low-impact pattern. Sampled audit only.


@dataclass(frozen=True)
class BackstopHit:
    """A backstop's raw regex+validation match against a string."""

    entity_type: str
    start: int
    end: int
    backstop_name: str
    severity: Severity


@dataclass(frozen=True)
class BackstopMiss:
    """A confirmed miss: backstop caught PII that Presidio did not.

    Carries no cleartext — only a SHA-256-truncated hash of the matched
    substring. Audit / log surfaces must never reconstruct the original.
    """

    entity_type: str
    backstop_name: str
    severity: Severity
    sample_hash: str
    span_start: int
    span_end: int


class Backstop(Protocol):
    name: str
    entity_type: str
    severity: Severity

    def find(self, text: str) -> list[BackstopHit]:
        """Return every hit in ``text``. Order is not significant; callers
        deduplicate against Presidio's span list."""
        ...
