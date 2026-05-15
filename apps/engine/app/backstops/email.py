"""Email backstop.

Permissive RFC-ish: local-part of common characters, ``@``, then a domain
with at least one dot. Not strictly RFC 5321/5322 — we err toward
catching everything Presidio missed at the cost of some over-match.
"""

from __future__ import annotations

import re

from app.backstops.base import Backstop, BackstopHit, Severity

_EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"
)


class EmailBackstop(Backstop):
    name = "email_backstop"
    entity_type = "EMAIL_ADDRESS"
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
            for m in _EMAIL_RE.finditer(text)
        ]
