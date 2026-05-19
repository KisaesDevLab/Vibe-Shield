"""Hybrid PDF scanner — Phase 26 v1.9.

Born-digital PDFs (QuickBooks exports, accounting-firm statements)
have a text layer; we pull and analyze that. Scanned PDFs (bank
statements that came in as JPEGs glued into a PDF wrapper) have no
text layer; we rasterize each page and run Tesseract OCR.

The hybrid scanner tries text-layer first; if a page yields zero
text characters, it falls back to OCR for that page only. Pages with
text get analyzed once; pages without get the OCR path. Findings
carry the same ``page=N,char=X-Y`` location format either way.

This replaces v1.8's ``PdfTextScanner``. The old name is kept as an
export so external callers don't break.
"""

from __future__ import annotations

import hashlib
import io
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import IO, Any

from app.analyzer import AnalyzerService, EntitySpan

from .base import (
    FileScanned,
    FileSkipped,
    ScanContext,
    ScanEvent,
    Scanner,
    findings_for_text,
)


class ImagePdfScanner(Scanner):
    """Hybrid text-then-OCR scanner. Always wins over the legacy
    ``PdfTextScanner`` in the registry — they share the same surface
    but this one falls back to OCR per-page."""

    @property
    def name(self) -> str:
        return "pdf_hybrid"

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

        try:
            reader = PdfReader(io.BytesIO(raw))
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

        # Decide whether the OCR path is even worth trying. If
        # pdf2image / tesseract aren't installed we'll fall back to
        # text-layer-only and quietly emit zero findings for blank pages.
        ocr_stack = _try_load_ocr_stack()

        yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)

        # Rasterize lazily — only on the first page that needs OCR.
        rasterized: list[bytes] | None = None

        for page_no, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""

            if text.strip():
                def _text_loc(span: EntitySpan, p: int = page_no) -> str:
                    return f"page={p},char={span.start}-{span.end}"

                yield from findings_for_text(
                    path=path,
                    text=text,
                    analyzer=analyzer,
                    ctx=ctx,
                    location_for=_text_loc,
                )
                continue

            # No text layer for this page — try OCR.
            if ocr_stack is None:
                continue
            convert_fn, backend_cls = ocr_stack

            if rasterized is None:
                try:
                    images = convert_fn(raw, dpi=200, fmt="png")
                except Exception:
                    # Can't rasterize → silently fall back to text-only for the rest.
                    rasterized = []
                    continue
                rasterized = []
                for img in images:
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    rasterized.append(buf.getvalue())

            if page_no - 1 >= len(rasterized):
                continue

            try:
                ocr_backend = backend_cls()
                ocr_result = ocr_backend.run(rasterized[page_no - 1])
            except Exception:  # noqa: S112
                continue
            ocr_text = ocr_result.text or ""
            if not ocr_text.strip():
                continue

            def _ocr_loc(span: EntitySpan, p: int = page_no) -> str:
                return f"page={p},char={span.start}-{span.end}"

            yield from findings_for_text(
                path=path,
                text=ocr_text,
                analyzer=analyzer,
                ctx=ctx,
                location_for=_ocr_loc,
            )


def _try_load_ocr_stack() -> tuple[Callable[..., Any], type] | None:
    """Return ``(convert_from_bytes, TesseractOcrBackend)`` or None
    if either dep is missing — the hybrid scanner then treats text-
    layer extraction as the only path."""
    try:
        from pdf2image import convert_from_bytes
    except ImportError:
        return None
    try:
        from app.image import TesseractOcrBackend
    except ImportError:
        return None
    return (convert_from_bytes, TesseractOcrBackend)
