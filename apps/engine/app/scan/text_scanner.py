"""Plain-text + CSV scanners — Phase 26."""

from __future__ import annotations

import csv
import hashlib
import io
from collections.abc import Iterator
from pathlib import Path
from typing import IO

from app.analyzer import AnalyzerService, EntitySpan

from .base import (
    FileScanned,
    Finding,
    ScanContext,
    ScanEvent,
    Scanner,
    findings_for_text,
)

PLAIN_TEXT_MIMES = {
    "text/plain",
    "text/markdown",
    "text/x-log",
    "application/octet-stream",  # treated as best-effort utf-8
}

PLAIN_TEXT_EXTS = {".txt", ".md", ".log", ".conf", ".ini", ".json", ".yaml", ".yml"}


def _hash_and_decode(body: IO[bytes]) -> tuple[str, str]:
    """Read body fully → (sha256_hex, text_decoded). Falls back to
    latin-1 if utf-8 fails so we don't lose log-style files mid-scan."""

    raw = body.read()
    sha = hashlib.sha256(raw).hexdigest()
    try:
        return sha, raw.decode("utf-8")
    except UnicodeDecodeError:
        return sha, raw.decode("latin-1", errors="replace")


class PlainTextScanner(Scanner):
    @property
    def name(self) -> str:
        return "plain_text"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime in PLAIN_TEXT_MIMES or ext in PLAIN_TEXT_EXTS or mime.startswith(
            "text/"
        )

    def scan(
        self,
        path: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
        analyzer: AnalyzerService,
        ctx: ScanContext,
    ) -> Iterator[ScanEvent]:
        sha, text = _hash_and_decode(body)
        yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)

        # Process line-by-line so the location field stays meaningful
        # even for big logs. char positions are within the line.
        offset = 0
        for line_no, line in enumerate(text.splitlines(keepends=True), start=1):
            if not line.strip():
                offset += len(line)
                continue
            def _loc(span: EntitySpan, n: int = line_no) -> str:
                return f"line={n},char={span.start}-{span.end}"

            yield from findings_for_text(
                path=path,
                text=line,
                analyzer=analyzer,
                ctx=ctx,
                location_for=_loc,
            )
            offset += len(line)


class CsvScanner(Scanner):
    """Streaming CSV scanner.

    Each cell is its own analysis target — Presidio is happier with
    short, semantically-meaningful text than concatenated rows, and
    the location field can pinpoint the cell. Header row is detected
    by csv.Sniffer and used to enrich the location string with the
    column name.
    """

    @property
    def name(self) -> str:
        return "csv"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime in {"text/csv", "application/csv"} or ext == ".csv"

    def scan(
        self,
        path: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
        analyzer: AnalyzerService,
        ctx: ScanContext,
    ) -> Iterator[ScanEvent]:
        sha, text = _hash_and_decode(body)
        yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)

        # Sniff dialect + header.
        sample = text[:8192]
        dialect: type[csv.Dialect] | csv.Dialect
        try:
            dialect = csv.Sniffer().sniff(sample)
        except csv.Error:
            dialect = csv.excel
        has_header = False
        try:
            has_header = csv.Sniffer().has_header(sample)
        except csv.Error:
            has_header = False

        reader = csv.reader(io.StringIO(text), dialect=dialect)
        header: list[str] | None = None
        for row_no, row in enumerate(reader, start=1):
            if row_no == 1 and has_header:
                header = row
                continue
            for col_no, raw in enumerate(row):
                cell = raw.strip()
                if not cell:
                    continue
                col_label = _column_label(col_no, header)

                def _loc(_span: EntitySpan, r: int = row_no, c: str = col_label) -> str:
                    return f"row={r},col={c}"

                yield from findings_for_text(
                    path=path,
                    text=cell,
                    analyzer=analyzer,
                    ctx=ctx,
                    location_for=_loc,
                )


def _column_label(col_no: int, header: list[str] | None) -> str:
    """``A`` / ``B`` / ``C`` … with the header name appended if known."""

    letter = _excel_column(col_no)
    if header is not None and col_no < len(header) and header[col_no].strip():
        return f"{letter} ({header[col_no].strip()})"
    return letter


def _excel_column(idx: int) -> str:
    """0 → A, 1 → B, …, 26 → AA, …"""

    out = ""
    n = idx
    while True:
        out = chr(ord("A") + (n % 26)) + out
        n = n // 26 - 1
        if n < 0:
            break
    return out


# Avoid unused-import noise; ``Finding`` is part of the public surface.
__all__ = ["CsvScanner", "Finding", "PlainTextScanner"]
