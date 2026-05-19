"""Scanner abstractions — Phase 26.

A Scanner is a small object that knows how to read one kind of file
and emit ``Finding`` records. The ``ScanRunner`` orchestrates the
dispatch from MIME / extension to scanner, holds the shared analyzer,
and applies the per-file safety budget (size cap, timeout).

Findings deliberately carry only a redacted snippet plus a SHA-256 of
the cleartext span — never the cleartext itself. The gateway pipeline
trusts this contract; the no-leak test in the schema package enforces
it on the DB side.
"""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

from app.analyzer import AnalyzerService, EntitySpan

# Map entity type -> severity. Mirrors the BUILD_PLAN's recognizer
# severity policy: anything that's a direct identifier (SSN, EIN, bank
# account, routing) is high; quasi-identifiers like names + DOB are
# medium; email + phone are low (they're frequently in scope-of-work
# documents intentionally).
DEFAULT_SEVERITY: dict[str, str] = {
    "US_SSN": "high",
    "US_ITIN": "high",
    "US_EIN": "high",
    "US_BANK_ACCOUNT": "high",
    "US_BANK_ROUTING": "high",
    "CREDIT_CARD": "high",
    "US_DRIVER_LICENSE": "high",
    "US_PASSPORT": "high",
    "US_DOB": "medium",
    "DATE_OF_BIRTH": "medium",
    "PERSON": "medium",
    "LOCATION": "medium",
    "ADDRESS": "medium",
    "US_ADDRESS": "medium",
    "EMAIL_ADDRESS": "low",
    "PHONE_NUMBER": "low",
    "US_PHONE_NUMBER": "low",
    "URL": "low",
}


def severity_for(entity_type: str) -> str:
    """Return ``'low'|'medium'|'high'`` for an entity type. Unknown
    types default to ``'medium'`` rather than ``'low'`` so a future
    recognizer addition doesn't silently downgrade its findings."""

    return DEFAULT_SEVERITY.get(entity_type, "medium")


@dataclass(frozen=True)
class Finding:
    """One detected PII span inside one inner file."""

    path: str
    """Relative path inside the scan source (or the source filename itself)."""

    entity_type: str
    severity: str
    location: str
    """Scanner-specific location string. See ``vs_scan_findings.location`` comment."""

    snippet_redacted: str
    """Tiny context window with the entity replaced by ``<ENTITY_TYPE>``."""

    sample_hash: str
    """SHA-256(cleartext) — dedupe + audit without storing PII."""


@dataclass(frozen=True)
class FileSkipped:
    """Sentinel — emitted instead of findings when an inner file
    couldn't be scanned (encrypted, unsupported, too large, …).

    The runner still records a ``vs_scan_files`` row for it so the
    SPA can show the user *what* was skipped and why; just no
    findings rows.
    """

    path: str
    mime: str
    size_bytes: int
    sha256: str
    reason: str


@dataclass(frozen=True)
class FileScanned:
    """Companion sentinel — emitted before findings so the runner can
    materialize a ``vs_scan_files`` row and join findings against it
    by id."""

    path: str
    mime: str
    size_bytes: int
    sha256: str


# A scanner yields a stream of mixed Finding / FileScanned / FileSkipped.
ScanEvent = Finding | FileScanned | FileSkipped


@dataclass
class ScanContext:
    """Per-job knobs handed to every scanner invocation."""

    max_file_bytes: int = 100 * 1024 * 1024
    max_archive_depth: int = 3
    max_archive_files: int = 5000
    max_archive_total_bytes: int = 1024 * 1024 * 1024  # 1 GB
    # Tiny window of characters either side of the entity to surface
    # in the SPA without surfacing the PII itself.
    snippet_window: int = 40


class Scanner(ABC):
    """Abstract scanner. One concrete impl per file family."""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def supports(self, path: str, mime: str) -> bool: ...

    @abstractmethod
    def scan(
        self,
        path: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
        analyzer: AnalyzerService,
        ctx: ScanContext,
    ) -> Iterator[ScanEvent]: ...


class ScannerRegistry:
    """Holds the concrete scanners and dispatches a (path, mime) pair
    to the first one that supports it."""

    def __init__(self, scanners: Iterable[Scanner]) -> None:
        self._scanners = list(scanners)

    def for_file(self, path: str, mime: str) -> Scanner | None:
        for s in self._scanners:
            if s.supports(path, mime):
                return s
        return None

    def list(self) -> list[Scanner]:
        return list(self._scanners)


@dataclass
class ScanRunner:
    """Top-level entry point. Given the source upload bytes + filename,
    dispatch to either a single-file scan or an archive scan and
    yield the merged event stream."""

    analyzer: AnalyzerService
    registry: ScannerRegistry
    ctx: ScanContext = field(default_factory=ScanContext)

    def run(
        self,
        source_name: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
    ) -> Iterator[ScanEvent]:
        scanner = self.registry.for_file(source_name, mime)
        if scanner is None:
            yield FileSkipped(
                path=source_name,
                mime=mime,
                size_bytes=size_bytes,
                sha256=_sha256_stream(body),
                reason=f"no scanner registered for {mime} / {Path(source_name).suffix}",
            )
            return
        if size_bytes > self.ctx.max_file_bytes:
            yield FileSkipped(
                path=source_name,
                mime=mime,
                size_bytes=size_bytes,
                sha256=_sha256_stream(body),
                reason=f"file exceeds {self.ctx.max_file_bytes} byte cap",
            )
            return
        yield from scanner.scan(
            source_name,
            body,
            size_bytes,
            mime,
            self.analyzer,
            self.ctx,
        )


def _sha256_stream(body: IO[bytes]) -> str:
    """Read body fully and hash it. Used only on the early-exit paths
    where we still want to record what was skipped."""

    h = hashlib.sha256()
    body.seek(0)
    while True:
        chunk = body.read(64 * 1024)
        if not chunk:
            break
        h.update(chunk)
    body.seek(0)
    return h.hexdigest()


# ---- Shared finding helpers --------------------------------------------------


def findings_for_text(
    *,
    path: str,
    text: str,
    analyzer: AnalyzerService,
    ctx: ScanContext,
    location_for: Callable[[EntitySpan], str],
) -> Iterator[Finding]:
    """Run the analyzer over a text block and yield one ``Finding``
    per detected span. ``location_for(span)`` is a closure that
    formats the scanner-specific location string from the EntitySpan
    + the underlying text indices."""

    spans = analyzer.analyze(text)
    for span in spans:
        yield Finding(
            path=path,
            entity_type=span.entity_type,
            severity=severity_for(span.entity_type),
            location=location_for(span),
            snippet_redacted=_redacted_snippet(text, span, ctx.snippet_window),
            sample_hash=_sample_hash(text, span),
        )


def _redacted_snippet(text: str, span: EntitySpan, window: int) -> str:
    """Build the ``<context...><ENTITY>...<context>`` preview."""

    start = max(0, span.start - window)
    end = min(len(text), span.end + window)
    prefix = text[start : span.start].replace("\n", " ")
    suffix = text[span.end : end].replace("\n", " ")
    return f"{prefix}<{span.entity_type}>{suffix}"


def _sample_hash(text: str, span: EntitySpan) -> str:
    """SHA-256 of the cleartext span — for dedupe + audit. The
    cleartext span itself never leaves this function."""

    cleartext = text[span.start : span.end]
    return hashlib.sha256(cleartext.encode("utf-8")).hexdigest()
