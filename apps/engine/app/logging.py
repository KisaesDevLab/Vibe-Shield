"""Structured JSON logging.

Hard rule #1: cleartext PII never appears in logs. The logger configured
here only emits a fixed set of fields per record (timestamp, level, name,
message, correlation_id, plus any allowlisted ``extra`` keys). Callers must
never pass request bodies, redacted text, or token maps as fields.
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

from pythonjsonlogger import jsonlogger

correlation_id_ctx: ContextVar[str | None] = ContextVar("correlation_id", default=None)


_ALLOWED_EXTRA_KEYS = frozenset(
    {
        "method",
        "path",
        "status_code",
        "latency_ms",
        "entity_count",
        "entity_type",
        "model",
        "version",
        "request_bytes",
        "error_class",
    }
)


class _CorrelationFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.correlation_id = correlation_id_ctx.get()
        return True


class _SafeJsonFormatter(jsonlogger.JsonFormatter):
    """Drops any ``extra`` field not on the allowlist.

    This is the structural enforcement of "no payload bodies in logs". A
    well-meaning future caller cannot accidentally leak by passing
    ``extra={"text": "..."}`` — the field is silently discarded.
    """

    def add_fields(
        self,
        log_record: dict[str, Any],
        record: logging.LogRecord,
        message_dict: dict[str, Any],
    ) -> None:
        super().add_fields(log_record, record, message_dict)
        for key in list(log_record.keys()):
            if key in {"message", "level", "timestamp", "name", "correlation_id"}:
                continue
            if key not in _ALLOWED_EXTRA_KEYS:
                log_record.pop(key, None)
        if "level" not in log_record:
            log_record["level"] = record.levelname.lower()
        if "timestamp" not in log_record:
            log_record["timestamp"] = self.formatTime(record, self.datefmt)


def configure_logging(level: str = "info") -> None:
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        _SafeJsonFormatter(
            "%(timestamp)s %(level)s %(name)s %(message)s %(correlation_id)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    )
    handler.addFilter(_CorrelationFilter())
    root.addHandler(handler)
    root.setLevel(level.upper())

    for noisy in ("uvicorn.access", "uvicorn.error"):
        logging.getLogger(noisy).handlers = [handler]
        logging.getLogger(noisy).propagate = False


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
