"""Error handlers and domain exceptions.

Hard rule #1: error responses must never include cleartext PII. FastAPI's
default RequestValidationError handler echoes the offending ``input`` value
(which is user-supplied text), and the default 500 handler echoes the raw
exception message (which downstream libraries may build from the input).
Both paths are sealed here.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.logging import correlation_id_ctx, get_logger

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = get_logger("vibe_shield.engine.errors")


class EngineUnavailable(Exception):
    """Raised when the redaction pipeline cannot complete a request.

    Mapped to HTTP 503 by the global handler. The message is logged as
    ``error_class`` only; it is never echoed back to the client.
    """


def _envelope(status_code: int, error: str) -> dict[str, Any]:
    return {
        "error": error,
        "correlation_id": correlation_id_ctx.get(),
    }


async def validation_exception_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    """Sanitized 422 — field locations + error type only, never the input value."""
    safe_details = [
        {"loc": list(err.get("loc", [])), "type": err.get("type", "unknown")}
        for err in exc.errors()
    ]
    logger.warning("validation_error", extra={"error_class": "RequestValidationError"})
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            **_envelope(status.HTTP_422_UNPROCESSABLE_ENTITY, "validation_error"),
            "details": safe_details,
        },
    )


async def engine_unavailable_handler(_: Request, exc: EngineUnavailable) -> JSONResponse:
    logger.error(
        "engine_unavailable",
        extra={"error_class": type(exc).__name__},
    )
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content=_envelope(status.HTTP_503_SERVICE_UNAVAILABLE, "engine_unavailable"),
    )


async def generic_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    """Catch-all 500. The exception message is logged via ``error_class``
    only — it is never written to the response body, because downstream
    libraries (Presidio, spaCy, regex) may build exception messages from
    the input text."""
    logger.error(
        "internal_error",
        extra={"error_class": type(exc).__name__},
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=_envelope(status.HTTP_500_INTERNAL_SERVER_ERROR, "internal_error"),
    )


def install_error_handlers(app: FastAPI) -> None:
    # Starlette types the handler param as ``Callable[[Request, Exception], ...]``;
    # FastAPI then narrows by exception type at call time. The narrowed
    # signatures below are correct at runtime but mypy can't see the
    # narrowing — ignore the arg-type at the registration site.
    app.add_exception_handler(RequestValidationError, validation_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(EngineUnavailable, engine_unavailable_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, generic_exception_handler)
