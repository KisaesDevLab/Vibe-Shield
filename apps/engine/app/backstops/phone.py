"""Phone backstop.

US-centric: NANP formats (with/without parens, dots, dashes, spaces) and
E.164 (`+1` prefix). 7-digit local numbers without area code are not
matched — too noisy.
"""

from __future__ import annotations

import re

from app.backstops.base import Backstop, BackstopHit, Severity

# Variants:
#   +1 555 555 5555           E.164 / international
#   +1-555-555-5555
#   (555) 555-5555            NANP parenthesized
#   555-555-5555              NANP dashed
#   555.555.5555              NANP dotted
#   555 555 5555              NANP spaced
_PHONE_RE = re.compile(
    r"""
    (?<![\d.])                              # no preceding digit / dot
    (?:
        \+1[\s.-]?                          # optional +1
    )?
    (?:
        \(?\d{3}\)?[\s.-]?                  # area code
    )
    \d{3}[\s.-]?                            # exchange
    \d{4}                                   # subscriber
    (?:\s?(?:ext|x)\.?\s?\d{1,5})?          # optional extension
    \b
    """,
    re.IGNORECASE | re.VERBOSE,
)


class PhoneBackstop(Backstop):
    name = "phone_backstop"
    entity_type = "PHONE_NUMBER"
    severity = Severity.BLOCK

    def find(self, text: str) -> list[BackstopHit]:
        hits: list[BackstopHit] = []
        for m in _PHONE_RE.finditer(text):
            digits = re.sub(r"\D", "", m.group(0).split("ext")[0].split("Ext")[0])
            # Need at least 10 digits (NANP area+exchange+subscriber).
            if len(digits) < 10:
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
