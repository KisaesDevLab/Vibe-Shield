"""Per-request deterministic tokenization.

Phase 2 scope: within a single request, identical cleartext for the same
entity type collapses to the same token. Phase 6 promotes this to
session-scoped allocation backed by the Postgres token vault, so the same
cleartext stays stable across multiple requests in one bookkeeping session
(and gets a *different* token in a different session — a privacy property
so Anthropic cannot correlate sessions).

Until Phase 6, callers get fresh allocations per request. That is
intentional — no token vault exists yet, so cross-request determinism would
be a lie.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.analyzer import EntitySpan


@dataclass(frozen=True)
class TokenAllocation:
    token: str
    entity_type: str
    cleartext: str


@dataclass
class RequestTokenizer:
    _by_value: dict[tuple[str, str], str] = field(default_factory=dict)
    _counters: dict[str, int] = field(default_factory=dict)

    def allocate(self, entity_type: str, cleartext: str) -> str:
        key = (entity_type, cleartext)
        existing = self._by_value.get(key)
        if existing is not None:
            return existing
        n = self._counters.get(entity_type, 0) + 1
        self._counters[entity_type] = n
        token = f"<{entity_type}_{n}>"
        self._by_value[key] = token
        return token

    def redact(self, text: str, spans: list[EntitySpan]) -> tuple[str, list[TokenAllocation]]:
        if not spans:
            return text, []
        ordered = sorted(spans, key=lambda s: (s.start, -s.end))
        # Strip overlaps: keep the highest-scoring span for any overlapping region.
        kept: list[EntitySpan] = []
        for span in ordered:
            if kept and span.start < kept[-1].end:
                if span.score > kept[-1].score:
                    kept[-1] = span
                continue
            kept.append(span)

        out: list[str] = []
        cursor = 0
        allocations: list[TokenAllocation] = []
        seen: set[str] = set()
        for span in kept:
            out.append(text[cursor : span.start])
            cleartext = text[span.start : span.end]
            token = self.allocate(span.entity_type, cleartext)
            out.append(token)
            cursor = span.end
            if token not in seen:
                seen.add(token)
                allocations.append(
                    TokenAllocation(token=token, entity_type=span.entity_type, cleartext=cleartext)
                )
        out.append(text[cursor:])
        return "".join(out), allocations
