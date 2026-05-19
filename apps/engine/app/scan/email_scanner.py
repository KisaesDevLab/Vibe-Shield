"""Email scanners — Phase 26 v1.9.

EmlScanner   — single ``.eml`` message (RFC 2822) parsed via stdlib ``email``.
MboxScanner  — Unix ``mbox`` file holding many messages; iterated via stdlib ``mailbox``.

Both walk: Subject + From + To + Cc + the text/plain body, plus
each attachment recursively dispatched through the registry. Multipart
HTML bodies are stripped to text (best-effort, no JS execution).

Location formats:
  EmlScanner:   ``part=subject|from|to|cc|body``
  MboxScanner:  ``message=N,part=...``

Attachments use the same ``inner_path = "<outer>!<attachment_name>"``
convention as the zip archive scanner so the SPA renders them in a
familiar way.

PST (Outlook) format is deferred to v1.10 — needs ``libpff-python``
which requires a native C library build.
"""

from __future__ import annotations

import hashlib
import io
import mailbox
from collections.abc import Iterator
from email import message_from_bytes, policy
from email.message import EmailMessage
from html.parser import HTMLParser
from pathlib import Path
from typing import IO

from app.analyzer import AnalyzerService, EntitySpan

from .base import (
    FileScanned,
    FileSkipped,
    ScanContext,
    ScanEvent,
    Scanner,
    ScannerRegistry,
    findings_for_text,
)


class _TextExtractor(HTMLParser):
    """Tiny HTML → text stripper. Discards script/style content."""

    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []
        self._skip = False

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self._skip = True

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"}:
            self._skip = False

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._chunks.append(data)

    def text(self) -> str:
        return " ".join(c.strip() for c in self._chunks if c.strip())


def _html_to_text(html: str) -> str:
    p = _TextExtractor()
    try:
        p.feed(html)
    except Exception:
        return ""
    return p.text()


def _body_text(msg: EmailMessage) -> str:
    """Extract the best-effort text body from an EmailMessage."""

    # Prefer text/plain over text/html; fall back to whatever's there.
    body = msg.get_body(preferencelist=("plain", "html"))
    if body is None:
        return ""
    payload = body.get_content() if isinstance(body, EmailMessage) else None
    if payload is None:
        return ""
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8", errors="replace")
    if body.get_content_type() == "text/html":
        return _html_to_text(payload)
    return payload


def _scan_one_message(
    *,
    msg: EmailMessage,
    outer_path: str,
    msg_index: int | None,
    analyzer: AnalyzerService,
    ctx: ScanContext,
    registry: ScannerRegistry | None,
) -> Iterator[ScanEvent]:
    """Yield findings for one message. ``msg_index`` is None for a
    standalone .eml; an integer for the Nth message in an mbox."""

    prefix = "" if msg_index is None else f"message={msg_index},"

    # Header fields.
    for field, value in (
        ("subject", str(msg.get("Subject") or "")),
        ("from", str(msg.get("From") or "")),
        ("to", str(msg.get("To") or "")),
        ("cc", str(msg.get("Cc") or "")),
    ):
        if not value.strip():
            continue

        def _loc(_span: EntitySpan, f: str = field, pfx: str = prefix) -> str:
            return f"{pfx}part={f}"

        yield from findings_for_text(
            path=outer_path,
            text=value,
            analyzer=analyzer,
            ctx=ctx,
            location_for=_loc,
        )

    # Body.
    body_text = _body_text(msg)
    if body_text.strip():
        def _body_loc(_span: EntitySpan, pfx: str = prefix) -> str:
            return f"{pfx}part=body"

        yield from findings_for_text(
            path=outer_path,
            text=body_text,
            analyzer=analyzer,
            ctx=ctx,
            location_for=_body_loc,
        )

    # Attachments — recursively dispatch through the registry, if
    # one was provided. (The runner injects it via the wiring in
    # ``main.py``.)
    if registry is None:
        return
    for part in msg.iter_attachments():
        filename = part.get_filename() or "attachment.bin"
        inner_path = f"{outer_path}!{filename}"
        att_mime = part.get_content_type() or "application/octet-stream"
        try:
            payload = part.get_content()
        except Exception:  # noqa: S112
            continue
        if isinstance(payload, str):
            payload = payload.encode("utf-8", errors="replace")
        if not isinstance(payload, (bytes, bytearray)):
            continue

        att_size = len(payload)
        if att_size > ctx.max_file_bytes:
            yield FileSkipped(
                path=inner_path,
                mime=att_mime,
                size_bytes=att_size,
                sha256="",
                reason=f"attachment exceeds {ctx.max_file_bytes} byte cap",
            )
            continue

        scanner = registry.for_file(filename, att_mime)
        if scanner is None:
            yield FileSkipped(
                path=inner_path,
                mime=att_mime,
                size_bytes=att_size,
                sha256=hashlib.sha256(bytes(payload)).hexdigest(),
                reason=f"no scanner for {att_mime}",
            )
            continue

        yield from scanner.scan(
            inner_path,
            io.BytesIO(bytes(payload)),
            att_size,
            att_mime,
            analyzer,
            ctx,
        )


class EmlScanner(Scanner):
    """Single-message ``.eml`` scanner."""

    def __init__(self, registry: ScannerRegistry | None = None) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "email_eml"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime in {"message/rfc822", "application/eml"} or ext == ".eml"

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
            msg = message_from_bytes(raw, policy=policy.default)
        except Exception as exc:
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason=f"eml parse failed: {type(exc).__name__}",
            )
            return
        if not isinstance(msg, EmailMessage):
            yield FileSkipped(
                path=path,
                mime=mime,
                size_bytes=size_bytes,
                sha256=sha,
                reason="eml did not yield an EmailMessage",
            )
            return
        yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)
        yield from _scan_one_message(
            msg=msg,
            outer_path=path,
            msg_index=None,
            analyzer=analyzer,
            ctx=ctx,
            registry=self._registry,
        )


class MboxScanner(Scanner):
    """Unix mbox scanner — iterates every message in the file."""

    def __init__(self, registry: ScannerRegistry | None = None) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "email_mbox"

    def supports(self, path: str, mime: str) -> bool:
        ext = Path(path).suffix.lower()
        return mime == "application/mbox" or ext in {".mbox", ".mb"}

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
        # mailbox.mbox needs a real file path; spool to a NamedTemp.
        import tempfile

        with tempfile.NamedTemporaryFile(
            suffix=".mbox", delete=False, mode="wb"
        ) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        try:
            try:
                box = mailbox.mbox(tmp_path)
            except Exception as exc:
                yield FileSkipped(
                    path=path,
                    mime=mime,
                    size_bytes=size_bytes,
                    sha256=sha,
                    reason=f"mbox parse failed: {type(exc).__name__}",
                )
                return
            yield FileScanned(path=path, mime=mime, size_bytes=size_bytes, sha256=sha)
            for i, raw_msg in enumerate(box.values(), start=1):
                try:
                    msg = message_from_bytes(
                        raw_msg.as_bytes(), policy=policy.default
                    )
                except Exception:  # noqa: S112
                    continue
                if not isinstance(msg, EmailMessage):
                    continue
                yield from _scan_one_message(
                    msg=msg,
                    outer_path=path,
                    msg_index=i,
                    analyzer=analyzer,
                    ctx=ctx,
                    registry=self._registry,
                )
            box.close()
        finally:
            try:
                Path(tmp_path).unlink()
            except OSError:
                pass
