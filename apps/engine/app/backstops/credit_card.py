"""Credit-card backstop.

13-19 digit PANs (Visa/MC/Amex/Discover/JCB) with optional space/hyphen
grouping. Luhn checksum required — eliminates almost all false positives.
"""

from __future__ import annotations

import re

from app.backstops.base import Backstop, BackstopHit, Severity


def luhn_valid(digits: str) -> bool:
    if not digits or not digits.isdigit():
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


# 13-19 digits with optional grouping. The outer \b anchors at the digit
# boundary; the inner pattern allows space/hyphen between digit groups.
_CC_RE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")


class CreditCardBackstop(Backstop):
    name = "credit_card_backstop"
    entity_type = "CREDIT_CARD"
    severity = Severity.BLOCK

    def find(self, text: str) -> list[BackstopHit]:
        hits: list[BackstopHit] = []
        for m in _CC_RE.finditer(text):
            digits = re.sub(r"[ -]", "", m.group(0))
            if not (13 <= len(digits) <= 19):
                continue
            if not luhn_valid(digits):
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
