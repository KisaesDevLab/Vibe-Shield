"""Scan module — Phase 26 (v1.8 foundation).

Scanners take an input file (or an in-memory bytes buffer + a path
hint) and yield a stream of ``Finding`` records pointing at the
locations of unredacted PII inside that file. The Redact module's
existing ``AnalyzerService`` is reused for the per-text-block PII
detection; scanners are responsible for breaking each file into
analyzable text blocks and tagging the location appropriately.

v1.8 covers:
  - PlainTextScanner   (text/*, log, conf)
  - CsvScanner         (text/csv — streaming, header detection)
  - OfficeDocScanner   (xlsx via openpyxl)
  - PdfTextScanner     (PDF text layer; ImagePdfScanner deferred to v1.9)
  - ArchiveScanner     (zip; 7z + tar deferred to v1.9)

Each scanner enforces:
  - 60s per-file timeout (engine sets a cancellation token).
  - 100 MB default size cap; configurable.
  - Skip-not-fail: encrypted entries / unsupported types yield a
    ``Finding`` with ``skipped_reason`` instead of throwing.
"""

from .archive_scanner import ArchiveScanner
from .base import Finding, ScanContext, Scanner, ScannerRegistry, ScanRunner
from .email_scanner import EmlScanner, MboxScanner
from .image_pdf_scanner import ImagePdfScanner
from .office_scanner import OfficeDocScanner
from .pdf_text_scanner import PdfTextScanner
from .text_scanner import CsvScanner, PlainTextScanner

__all__ = [
    "ArchiveScanner",
    "CsvScanner",
    "EmlScanner",
    "Finding",
    "ImagePdfScanner",
    "MboxScanner",
    "OfficeDocScanner",
    "PdfTextScanner",
    "PlainTextScanner",
    "ScanContext",
    "ScanRunner",
    "Scanner",
    "ScannerRegistry",
]
