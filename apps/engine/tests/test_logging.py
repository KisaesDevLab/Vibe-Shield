"""Hard rule #1 enforcement test.

Cleartext PII must never appear in log records. This test exercises the
logging stack with a payload-shaped string and asserts the formatter strips
any non-allowlisted ``extra`` field. If a future change widens the
allowlist or routes payload bodies through the logger, this test fails.
"""

from __future__ import annotations

import io
import json
import logging

from app.logging import configure_logging, correlation_id_ctx


def test_extra_payload_keys_are_dropped() -> None:
    configure_logging("info")
    buf = io.StringIO()
    root = logging.getLogger()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(root.handlers[0].formatter)
    handler.addFilter(root.handlers[0].filters[0])
    root.addHandler(handler)
    try:
        token = correlation_id_ctx.set("test-cid")
        try:
            root.info(
                "request",
                extra={
                    "method": "POST",
                    "path": "/redact",
                    "status_code": 200,
                    "latency_ms": 12.3,
                    # The forbidden ones — must not survive into the JSON record.
                    "text": "SSN 900-12-3456 belongs to Jane Doe",
                    "redacted_text": "SSN <US_SSN_1> belongs to <PERSON_1>",
                    "tokens": {"<US_SSN_1>": "900-12-3456"},
                },
            )
        finally:
            correlation_id_ctx.reset(token)
    finally:
        root.removeHandler(handler)

    line = buf.getvalue().strip().splitlines()[-1]
    record = json.loads(line)
    assert "method" in record
    assert record["method"] == "POST"
    assert record["correlation_id"] == "test-cid"
    # Forbidden fields must be absent — not redacted, not stringified, just gone.
    for forbidden in ("text", "redacted_text", "tokens"):
        assert forbidden not in record
    # And no PII substring should leak into the rendered line by any path.
    assert "900-12-3456" not in line
    assert "Jane Doe" not in line
