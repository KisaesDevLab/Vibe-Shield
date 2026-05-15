"""Prometheus metrics. Exposed at GET /metrics via prometheus_client.make_asgi_app."""

from __future__ import annotations

from typing import Any

from prometheus_client import CollectorRegistry, Counter, Histogram, make_asgi_app

REGISTRY = CollectorRegistry()

HTTP_REQUESTS = Counter(
    "vs_engine_http_requests_total",
    "Total HTTP requests received by the engine.",
    labelnames=("method", "path", "status"),
    registry=REGISTRY,
)

HTTP_LATENCY = Histogram(
    "vs_engine_http_latency_seconds",
    "HTTP request latency.",
    labelnames=("method", "path"),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
    registry=REGISTRY,
)

ENTITIES_DETECTED = Counter(
    "vs_engine_entities_detected_total",
    "Number of PII entities detected, by entity type.",
    labelnames=("entity_type",),
    registry=REGISTRY,
)


def metrics_asgi_app() -> Any:
    """Return the Prometheus ASGI app. Typed as ``Any`` because
    prometheus_client lacks stubs for the ASGI callable shape."""
    return make_asgi_app(registry=REGISTRY)
