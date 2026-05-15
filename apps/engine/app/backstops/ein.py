"""EIN backstop.

Pattern: ``\\b\\d{2}-\\d{7}\\b`` with the IRS-published valid-prefix list.
Same prefix table as the custom recognizer in ``app.recognizers.ein`` —
imported here to keep a single source of truth.
"""

from __future__ import annotations

import re

from app.backstops.base import Backstop, BackstopHit, Severity
from app.recognizers.ein import VALID_PREFIXES

_EIN_RE = re.compile(r"\b\d{2}-\d{7}\b")


class EinBackstop(Backstop):
    name = "ein_backstop"
    entity_type = "US_EIN"
    severity = Severity.BLOCK

    def find(self, text: str) -> list[BackstopHit]:
        hits: list[BackstopHit] = []
        for m in _EIN_RE.finditer(text):
            if m.group(0)[:2] not in VALID_PREFIXES:
                continue
            hits.append(
                BackstopHit(
                    entity_type=self.entity_type,
                    start=m.start(),
                    end=m.end(),
                    backstop_name=self.name,
                    severity=self.severity,
                )
            )
        return hits
