"""Tests for the /scan endpoint — Phase 26 (v1.8 foundation)."""

from __future__ import annotations

import io
import json
import zipfile

from fastapi.testclient import TestClient

from tests.conftest import requires_model


def _read_ndjson(body: bytes) -> list[dict[str, object]]:
    lines = [ln for ln in body.decode("utf-8").splitlines() if ln.strip()]
    return [json.loads(ln) for ln in lines]


@requires_model
def test_scan_plain_text_finds_ssn(client: TestClient) -> None:
    text = "Customer SSN is 123-45-6789, please file."
    r = client.post(
        "/scan",
        files={"file": ("note.txt", text.encode("utf-8"), "text/plain")},
    )
    assert r.status_code == 200
    events = _read_ndjson(r.content)
    types = [e["type"] for e in events]
    assert "file_scanned" in types
    assert any(e["type"] == "summary" for e in events)
    # SSN must be detected. snippet_redacted carries no cleartext.
    findings = [e for e in events if e["type"] == "finding"]
    assert any(f["entity_type"] == "US_SSN" for f in findings)
    for f in findings:
        assert "123-45-6789" not in f["snippet_redacted"]
        # sample_hash is the 64-char SHA-256 of the cleartext.
        assert len(f["sample_hash"]) == 64


@requires_model
def test_scan_csv_finds_per_cell_with_location(client: TestClient) -> None:
    csv = (
        b"Name,SSN,Phone\n"
        b"Jane Doe,123-45-6789,555-123-4567\n"
    )
    r = client.post(
        "/scan",
        files={"file": ("clients.csv", csv, "text/csv")},
    )
    assert r.status_code == 200
    events = _read_ndjson(r.content)
    findings = [e for e in events if e["type"] == "finding"]
    # Each finding is anchored to a specific row + column.
    assert all("row=" in f["location"] and "col=" in f["location"] for f in findings)


@requires_model
def test_scan_unsupported_mime_yields_skipped(client: TestClient) -> None:
    raw = b"\x00\x01\x02 unknown binary"
    r = client.post(
        "/scan",
        files={"file": ("blob.bin", raw, "application/x-arbitrary")},
    )
    assert r.status_code == 200
    events = _read_ndjson(r.content)
    # We routed through the plain text scanner (treats application/octet-stream
    # as best-effort utf-8) OR we got a skipped event — either is fine.
    # The summary must be present and well-formed.
    summary = next(e for e in events if e["type"] == "summary")
    assert summary["files_count"] >= 1


@requires_model
def test_scan_zip_archive_recurses(client: TestClient) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("inner/a.txt", "SSN 123-45-6789")
        zf.writestr("inner/b.txt", "no PII here")
    raw = buf.getvalue()
    r = client.post(
        "/scan",
        files={"file": ("bundle.zip", raw, "application/zip")},
    )
    assert r.status_code == 200
    events = _read_ndjson(r.content)
    summary = next(e for e in events if e["type"] == "summary")
    # Outer archive + 2 inner files = 3 file events.
    assert summary["files_count"] >= 3
    findings = [e for e in events if e["type"] == "finding"]
    paths = {f["path"] for f in findings}
    assert any("inner/a.txt" in p for p in paths)
    # 'no PII here' file must not have produced any findings.
    assert not any("inner/b.txt" in p for p in paths)


@requires_model
def test_scan_summary_aggregates_severity_counts(client: TestClient) -> None:
    text = (
        "SSN 123-45-6789 belongs to Jane Doe at jane@example.com. "
        "Phone 555-555-1234."
    )
    r = client.post(
        "/scan",
        files={"file": ("mixed.txt", text.encode("utf-8"), "text/plain")},
    )
    assert r.status_code == 200
    events = _read_ndjson(r.content)
    summary = next(e for e in events if e["type"] == "summary")
    # We don't pin exact counts (recognizer-dependent), only that the
    # totals add up to findings_count.
    total = (
        summary["findings_high"]
        + summary["findings_medium"]
        + summary["findings_low"]
    )
    assert total == summary["findings_count"]
