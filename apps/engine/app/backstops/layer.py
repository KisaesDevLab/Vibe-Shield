"""Backstop layer.

Composes the six backstops, runs them after Presidio + whitelist, and
emits new spans only for matches that don't overlap an existing span.
Every non-overlapping match is also handed to ``miss_handler`` — that's
where the Phase 5 ``vs_recognizer_misses`` audit insert plugs in. Phase 4
defaults to a structured JSON log line.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterable

from app.analyzer import EntitySpan
from app.backstops.base import Backstop, BackstopHit, BackstopMiss
from app.backstops.credit_card import CreditCardBackstop
from app.backstops.ein import EinBackstop
from app.backstops.email import EmailBackstop
from app.backstops.phone import PhoneBackstop
from app.backstops.routing import RoutingBackstop
from app.backstops.ssn import SsnBackstop
from app.logging import get_logger

MissHandler = Callable[[BackstopMiss], None]

logger = get_logger("vibe_shield.engine.backstops")


def default_backstops() -> list[Backstop]:
    return [
        SsnBackstop(),
        EinBackstop(),
        RoutingBackstop(),
        CreditCardBackstop(),
        EmailBackstop(),
        PhoneBackstop(),
    ]


def _hash_sample(text: str) -> str:
    """SHA-256 truncated to 16 hex chars. Never reverse-recoverable;
    just enough to dedupe identical misses across requests."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _overlaps(hit: BackstopHit, span: EntitySpan) -> bool:
    return not (hit.end <= span.start or span.end <= hit.start)


def _default_miss_handler(miss: BackstopMiss) -> None:
    # Goes through the structured logger. The allowlist drops any field
    # not on the safe set, so we have to use a method whose extras *are*
    # allowlisted — here we encode the miss into the message itself
    # (severity + entity type + hash, no cleartext).
    logger.warning(
        f"backstop_miss entity={miss.entity_type} backstop={miss.backstop_name} "
        f"severity={miss.severity.value} sample_hash={miss.sample_hash}",
        extra={"entity_type": miss.entity_type},
    )


class BackstopLayer:
    def __init__(
        self,
        backstops: Iterable[Backstop] | None = None,
        miss_handler: MissHandler | None = None,
    ) -> None:
        self.backstops = list(backstops) if backstops is not None else default_backstops()
        self.miss_handler = miss_handler or _default_miss_handler

    def apply(
        self,
        text: str,
        existing_spans: list[EntitySpan],
    ) -> list[EntitySpan]:
        """Return ``existing_spans`` augmented with backstop catches.

        Side effect: every catch that doesn't overlap an existing span is
        a miss and gets sent to ``miss_handler``.
        """
        spans, _misses = self.apply_with_misses(text, existing_spans)
        return spans

    def apply_with_misses(
        self,
        text: str,
        existing_spans: list[EntitySpan],
    ) -> tuple[list[EntitySpan], list[BackstopMiss]]:
        """Same as ``apply`` but also returns the misses for the
        caller (in addition to invoking ``miss_handler`` for the
        log/metric path). Used by the /redact route so the gateway can
        persist misses to ``vs_recognizer_misses``."""
        new_spans: list[EntitySpan] = []
        misses: list[BackstopMiss] = []
        for bs in self.backstops:
            for hit in bs.find(text):
                if any(_overlaps(hit, sp) for sp in existing_spans):
                    continue
                if any(_overlaps(hit, sp) for sp in new_spans):
                    continue
                span = EntitySpan(
                    entity_type=hit.entity_type,
                    start=hit.start,
                    end=hit.end,
                    score=1.0,
                )
                new_spans.append(span)
                miss = BackstopMiss(
                    entity_type=hit.entity_type,
                    backstop_name=hit.backstop_name,
                    severity=hit.severity,
                    sample_hash=_hash_sample(text[hit.start : hit.end]),
                    span_start=hit.start,
                    span_end=hit.end,
                )
                misses.append(miss)
                self.miss_handler(miss)
        return [*existing_spans, *new_spans], misses
