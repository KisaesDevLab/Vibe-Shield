"""PDF text-layer scanner — Phase 26.

For PDFs that already have a text layer (born-digital documents from
QuickBooks, Lacerte, accounting-firm-issued statements, etc.), this
scanner pulls the text per page and runs the analyzer on each page.

For image-only PDFs (scans without OCR), this scanner reports the file
as having zero findings — the rasterize-then-OCR path lives in
ImagePdfScanner which reuses the existing Redact engine pipeline and
ships in v1.9.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import IO

from app.analyzer import AnalyzerService, EntitySpan

from .base import (
    FileScanned,
    FileSkipped,
    ScanContext,
    ScanEvent,
    Scanner,
    findings_for_text,
)


class PdfTextScanner(Scanner):
    @property
    def name(self) -> str:
        return "pdf_text"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime == "application/pdf" or ext == ".pdf"

    def scan(
        self,
        path: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
        analyzer: AnalyzerService,
        ctx: ScanContext,
    ) -> Iterator[ScanEvent]:
        raw = body.read()
        sha = hashlib.sha256(raw).hexdigest()

        try:
            from pypdf import PdfReader
        except ImportError:
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason="pypdf not installed",
            )
            return

        import io as _io

        try:
            reader = PdfReader(_io.BytesIO(raw))
        except Exception as exc:
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason=f"pypdf rejected: {type(exc).__name__}",
            )
            return

        if getattr(reader, "is_encrypted", False):
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason="pdf is password-protected",
            )
            return

        yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)

        for page_no, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if not text.strip():
                continue
            def _loc(span: EntitySpan, p: int = page_no) -> str:
                return f"page={p},char={span.start}-{span.end}"

            yield from findings_for_text(
                path=path,
                text=text,
                analyzer=analyzer,
                ctx=ctx,
                location_for=_loc,
            )
