"""ABA routing backstop.

9 contiguous digits + checksum (same algorithm as the custom recognizer).
``000000000`` is checksum-valid but a known degenerate case; explicitly
rejected here.
"""

from __future__ import annotations

import re

from app.backstops.base import Backstop, BackstopHit, Severity
from app.recognizers.aba_routing import aba_checksum_valid

_ABA_RE = re.compile(r"\b\d{9}\b")


class RoutingBackstop(Backstop):
    name = "routing_backstop"
    entity_type = "US_BANK_ROUTING"
    severity = Severity.BLOCK

    def find(self, text: str) -> list[BackstopHit]:
        hits: list[BackstopHit] = []
        for m in _ABA_RE.finditer(text):
            digits = m.group(0)
            if digits == "000000000":
                continue
            if not aba_checksum_valid(digits):
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
