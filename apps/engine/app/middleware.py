from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import HTTPException, Request, Response, status
from starlette.middleware.base import BaseHTTPMiddleware

from app.logging import correlation_id_ctx, get_logger
from app.metrics import HTTP_LATENCY, HTTP_REQUESTS

logger = get_logger("vibe_shield.engine.http")


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """Assign / propagate a correlation ID per request.

    Honors ``X-Correlation-Id`` from the gateway (so Vibe-Shield-wide tracing
    works); mints a UUID4 if absent. The ID is bound into a ContextVar so
    log records pick it up without explicit threading.
    """

    HEADER = "x-correlation-id"

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        cid = request.headers.get(self.HEADER) or str(uuid.uuid4())
        token = correlation_id_ctx.set(cid)
        try:
            response = await call_next(request)
        finally:
            correlation_id_ctx.reset(token)
        response.headers[self.HEADER] = cid
        return response


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject payloads larger than the configured ceiling.

    Defends against memory blow-up and provides a backstop against a caller
    accidentally shipping a megabyte of cleartext into the engine. Checks the
    ``Content-Length`` header first (cheap), then enforces the cap on the
    streamed body (defense for chunked uploads).
    """

    def __init__(self, app, max_bytes: int) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                if int(cl) > self.max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"request exceeds max_bytes={self.max_bytes}",
                    )
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="invalid content-length",
                ) from None
        return await call_next(request)


class AccessLogMiddleware(BaseHTTPMiddleware):
    """Per-request structured log + Prometheus counters.

    Logs only metadata: method, path, status, latency, request size. Never
    the body.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        start = time.perf_counter()
        path = request.url.path
        method = request.method
        request_bytes = int(request.headers.get("content-length") or 0)
        try:
            response = await call_next(request)
            status_code = response.status_code
        except Exception as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            HTTP_REQUESTS.labels(method=method, path=path, status="500").inc()
            HTTP_LATENCY.labels(method=method, path=path).observe(elapsed_ms / 1000.0)
            logger.exception(
                "request failed",
                extra={
                    "method": method,
                    "path": path,
                    "status_code": 500,
                    "latency_ms": round(elapsed_ms, 2),
                    "request_bytes": request_bytes,
                    "error_class": type(exc).__name__,
                },
            )
            raise
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        HTTP_REQUESTS.labels(method=method, path=path, status=str(status_code)).inc()
        HTTP_LATENCY.labels(method=method, path=path).observe(elapsed_ms / 1000.0)
        logger.info(
            "request",
            extra={
                "method": method,
                "path": path,
                "status_code": status_code,
                "latency_ms": round(elapsed_ms, 2),
                "request_bytes": request_bytes,
            },
        )
        return response
