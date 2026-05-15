"""SSN backstop.

Pattern from BUILD_PLAN.md §4 Phase 4:

    \\b(?!000|666|9\\d{2})\\d{3}[-\\s]?(?!00)\\d{2}[-\\s]?(?!0000)\\d{4}\\b

Excludes SSA-reserved/never-issued ranges (000, 666, 900-999 prefixes;
middle group 00; serial 0000).
"""

from __future__ import annotations

import re

from app.backstops.base import Backstop, BackstopHit, Severity

_SSN_RE = re.compile(
    r"\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b"
)


class SsnBackstop(Backstop):
    name = "ssn_backstop"
    entity_type = "US_SSN"
    severity = Severity.BLOCK

    def find(self, text: str) -> list[BackstopHit]:
        return [
            BackstopHit(
                entity_type=self.entity_type,
                start=m.start(),
                end=m.end(),
                backstop_name=self.name,
                severity=self.severity,
            )
            for m in _SSN_RE.finditer(text)
        ]
