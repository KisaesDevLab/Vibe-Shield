"""Office document scanner — xlsx via openpyxl.

v1.8 covers xlsx only. xls (legacy binary) needs ``xlrd<2`` which is
flag-gated and deferred to v1.9. odf / docx are likewise deferred.
"""

from __future__ import annotations

import hashlib
import io
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

XLSX_MIMES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",  # browsers occasionally mislabel
}


class OfficeDocScanner(Scanner):
    @property
    def name(self) -> str:
        return "office_doc"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime in XLSX_MIMES or ext in {".xlsx"}

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
            import openpyxl
        except ImportError:
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason="openpyxl not installed",
            )
            return

        try:
            wb = openpyxl.load_workbook(
                filename=io.BytesIO(raw),
                read_only=True,
                data_only=True,
            )
        except Exception as exc:
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason=f"openpyxl rejected workbook: {type(exc).__name__}",
            )
            return

        yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)

        for sheet in wb.worksheets:
            for row in sheet.iter_rows(values_only=False):
                for cell in row:
                    val = cell.value
                    if val is None:
                        continue
                    text = str(val).strip()
                    if not text:
                        continue
                    coord = cell.coordinate
                    sheet_name = sheet.title

                    def _loc(_span: EntitySpan, sn: str = sheet_name, c: str = coord) -> str:
                        return f"sheet={sn},cell={c}"

                    yield from findings_for_text(
                        path=path,
                        text=text,
                        analyzer=analyzer,
                        ctx=ctx,
                        location_for=_loc,
                    )

        wb.close()


