"""Archive scanner — zip in v1.8; 7z/tar deferred to v1.9.

Dispatches each inner file back to the registry. Enforces:

  - max depth (default 3): a zip-of-zip-of-zip can go 3 levels deep.
  - max total bytes (default 1 GB): cumulative uncompressed size.
  - max file count (default 5000): protects against zip bombs that
    use deep directory structures.
  - 100 MB per-inner-file cap (default; inherited from ScanContext).

Encrypted entries surface as ``FileSkipped`` with reason
``encrypted``. We never prompt for passwords — that would be an
attack vector and the appliance is unattended.
"""

from __future__ import annotations

import hashlib
import io
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import IO

from app.analyzer import AnalyzerService

from .base import (
    FileScanned,
    FileSkipped,
    ScanContext,
    ScanEvent,
    Scanner,
    ScannerRegistry,
)


class ArchiveScanner(Scanner):
    """Outer-zip scanner. Holds a reference to the registry so it can
    recurse into inner files via the right scanner."""

    def __init__(self, registry: ScannerRegistry) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "archive_zip"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime in {"application/zip", "application/x-zip-compressed"} or ext == ".zip"

    def scan(
        self,
        path: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
        analyzer: AnalyzerService,
        ctx: ScanContext,
    ) -> Iterator[ScanEvent]:
        yield from self._scan_zip(
            outer_path=path,
            body=body,
            size_bytes=size_bytes,
            mime=mime,
            analyzer=analyzer,
            ctx=ctx,
            depth=0,
        )

    def _scan_zip(
        self,
        *,
        outer_path: str,
        body: IO[bytes],
        size_bytes: int,
        mime: str,
        analyzer: AnalyzerService,
        ctx: ScanContext,
        depth: int,
    ) -> Iterator[ScanEvent]:
        raw = body.read()
        outer_sha = hashlib.sha256(raw).hexdigest()
        if depth >= ctx.max_archive_depth:
            yield FileSkipped(
                path=outer_path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=outer_sha,
                reason=f"archive depth exceeds {ctx.max_archive_depth}",
            )
            return

        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except (zipfile.BadZipFile, RuntimeError) as exc:
            yield FileSkipped(
                path=outer_path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=outer_sha,
                reason=f"bad zip: {type(exc).__name__}",
            )
            return

        # We always emit a FileScanned for the outer archive so the
        # SPA sees something for it; findings come from its children.
        yield FileScanned(
            path=outer_path,
            mime=mime,
            size_bytes=size_bytes,
            sha256=outer_sha,
        )

        total_bytes = 0
        seen_files = 0
        for info in zf.infolist():
            if info.is_dir():
                continue
            seen_files += 1
            if seen_files > ctx.max_archive_files:
                yield FileSkipped(
                    path=f"{outer_path}!{info.filename}",
                    mime="application/octet-stream",
                    size_bytes=info.file_size,
                    sha256="",
                    reason=f"archive exceeds {ctx.max_archive_files} files",
                )
                return
            total_bytes += info.file_size
            if total_bytes > ctx.max_archive_total_bytes:
                yield FileSkipped(
                    path=f"{outer_path}!{info.filename}",
                    mime="application/octet-stream",
                    size_bytes=info.file_size,
                    sha256="",
                    reason=f"archive exceeds {ctx.max_archive_total_bytes} total bytes",
                )
                return

            inner_path = f"{outer_path}!{info.filename}"
            inner_mime = _guess_mime(info.filename)

            # Encrypted entries surface in ``flag_bits`` bit 0.
            if info.flag_bits & 0x1:
                yield FileSkipped(
                    path=inner_path,
                    mime=inner_mime,
                    size_bytes=info.file_size,
                    sha256="",
                    reason="encrypted",
                )
                continue

            if info.file_size > ctx.max_file_bytes:
                yield FileSkipped(
                    path=inner_path,
                    mime=inner_mime,
                    size_bytes=info.file_size,
                    sha256="",
                    reason=f"inner file exceeds {ctx.max_file_bytes} byte cap",
                )
                continue

            try:
                inner_bytes = zf.read(info)
            except (RuntimeError, zipfile.BadZipFile) as exc:
                yield FileSkipped(
                    path=inner_path,
                    mime=inner_mime,
                    size_bytes=info.file_size,
                    sha256="",
                    reason=f"unzip failed: {type(exc).__name__}",
                )
                continue

            scanner = self._registry.for_file(inner_path, inner_mime)
            if scanner is None:
                yield FileSkipped(
                    path=inner_path,
                    mime=inner_mime,
                    size_bytes=info.file_size,
                    sha256=hashlib.sha256(inner_bytes).hexdigest(),
                    reason=f"no scanner for {inner_mime}",
                )
                continue

            if isinstance(scanner, ArchiveScanner):
                # Nested zip — recurse with bumped depth.
                yield from scanner._scan_zip(
                    outer_path=inner_path,
                    body=io.BytesIO(inner_bytes),
                    size_bytes=info.file_size,
                    mime=inner_mime,
                    analyzer=analyzer,
                    ctx=ctx,
                    depth=depth + 1,
                )
            else:
                yield from scanner.scan(
                    inner_path,
                    io.BytesIO(inner_bytes),
                    info.file_size,
                    inner_mime,
                    analyzer,
                    ctx,
                )


# Tiny MIME-from-extension table — enough to dispatch the right
# scanner without dragging in a full magic library.
_EXT_MIME: dict[str, str] = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".log": "text/x-log",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
}


def _guess_mime(filename: str) -> str:
    return _EXT_MIME.get(Path(filename).suffix.lower(), "application/octet-stream")


