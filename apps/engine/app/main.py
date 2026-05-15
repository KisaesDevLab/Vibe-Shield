from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request

from app import __version__
from app.analyzer import AnalyzerService
from app.config import Settings, load_settings
from app.errors import install_error_handlers
from app.image import ImageRedactor
from app.logging import configure_logging, get_logger
from app.metrics import ENTITIES_DETECTED, metrics_asgi_app
from app.middleware import (
    AccessLogMiddleware,
    CorrelationIdMiddleware,
    RequestSizeLimitMiddleware,
)
from app.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    EntitySpanModel,
    HealthResponse,
    MaskedRegionModel,
    RecognizerInfo,
    RecognizerMissEntry,
    RecognizersResponse,
    RedactImageResponse,
    RedactRequest,
    RedactResponse,
    TokenAllocationModel,
    TokenMapEntry,
)
from app.tokenizer import RequestTokenizer

logger = get_logger("vibe_shield.engine")


def create_app(settings: Settings | None = None, analyzer: AnalyzerService | None = None) -> FastAPI:
    cfg = settings or load_settings()
    configure_logging(cfg.log_level)
    svc = analyzer or AnalyzerService(spacy_model=cfg.spacy_model, language=cfg.default_language)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # Fail-closed startup: if the model can't load, we refuse to serve.
        svc.load()
        yield

    app = FastAPI(
        title="Vibe Shield Engine",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = cfg
    app.state.analyzer = svc

    # Sanitized error envelopes — see app/errors.py. Must be installed
    # before middleware so they take effect for all request paths.
    install_error_handlers(app)

    # Order matters: size limit first (cheapest reject), then correlation, then access log.
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(CorrelationIdMiddleware)
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=cfg.max_request_bytes)

    app.mount("/metrics", metrics_asgi_app())

    def get_analyzer(req: Request) -> AnalyzerService:
        analyzer_obj = req.app.state.analyzer
        assert isinstance(analyzer_obj, AnalyzerService)
        return analyzer_obj

    @app.get("/health", response_model=HealthResponse)
    def health(a: AnalyzerService = Depends(get_analyzer)) -> HealthResponse:
        return HealthResponse(
            status="ok" if a.is_loaded else "loading",
            model=a.spacy_model,
            model_loaded=a.is_loaded,
            recognizers_count=(len(a.list_recognizers()) if a.is_loaded else 0),
            version=__version__,
        )

    @app.get("/recognizers", response_model=RecognizersResponse)
    def recognizers(a: AnalyzerService = Depends(get_analyzer)) -> RecognizersResponse:
        return RecognizersResponse(
            model=a.spacy_model,
            recognizers=[
                RecognizerInfo(
                    name=r["name"],
                    supported_entities=r["supported_entities"],
                    supported_language=r["supported_language"],
                    version=r["version"],
                )
                for r in a.list_recognizers()
            ],
        )

    @app.post("/analyze", response_model=AnalyzeResponse)
    def analyze(
        body: AnalyzeRequest,
        a: AnalyzerService = Depends(get_analyzer),
    ) -> AnalyzeResponse:
        spans = a.analyze(body.text, language=body.language, entities=body.entities)
        for s in spans:
            ENTITIES_DETECTED.labels(entity_type=s.entity_type).inc()
        return AnalyzeResponse(results=[EntitySpanModel(**s.__dict__) for s in spans])

    @app.post("/redact", response_model=RedactResponse)
    def redact(
        body: RedactRequest,
        a: AnalyzerService = Depends(get_analyzer),
    ) -> RedactResponse:
        spans, misses = a.analyze_with_misses(
            body.text, language=body.language, entities=body.entities
        )
        for s in spans:
            ENTITIES_DETECTED.labels(entity_type=s.entity_type).inc()
        tokenizer = RequestTokenizer()
        redacted, allocations = tokenizer.redact(body.text, spans)
        return RedactResponse(
            redacted_text=redacted,
            spans=[EntitySpanModel(**s.__dict__) for s in spans],
            tokens=[TokenMapEntry(**a.__dict__) for a in allocations],
            misses=[
                RecognizerMissEntry(
                    entity_type=m.entity_type,
                    backstop_name=m.backstop_name,
                    severity=m.severity.value,
                    sample_hash=m.sample_hash,
                    span_start=m.span_start,
                    span_end=m.span_end,
                )
                for m in misses
            ],
        )

    @app.post("/redact-image", response_model=RedactImageResponse)
    def redact_image(
        body: dict[str, object],
        a: AnalyzerService = Depends(get_analyzer),
    ) -> RedactImageResponse:
        """Phase 17 image-redaction endpoint (slim v1.0).

        Accepts ``{"image_base64": <b64>}``, runs the stub OCR backend
        through the standard text pipeline, returns the masked image
        (currently identity-masker until v1.1 wires OpenCV) plus the
        token map and bbox audit. The API contract is stable — the
        Converter integrates against this shape today; v1.1 swaps the
        backend internals.
        """
        b64 = body.get("image_base64", "")
        if not isinstance(b64, str) or not b64:
            raise ValueError("image_base64 is required")
        image_bytes = base64.b64decode(b64)
        redactor = ImageRedactor(a)
        result = redactor.redact(image_bytes)
        return RedactImageResponse(
            image_sha256=result.image_sha256,
            masked_image_sha256=result.masked_image_sha256,
            masked_image_base64=base64.b64encode(result.masked_image_bytes).decode("ascii"),
            redacted_text=result.redacted_text,
            tokens=[
                TokenAllocationModel(token=t, entity_type=et, cleartext=ct)
                for (t, et, ct) in result.tokens
            ],
            masked_regions=[
                MaskedRegionModel(
                    entity_type=r.entity_type,
                    token=r.token,
                    x=r.x,
                    y=r.y,
                    width=r.width,
                    height=r.height,
                )
                for r in result.masked_regions
            ],
        )

    return app


app = create_app()
