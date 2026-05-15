from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request

from app import __version__
from app.analyzer import AnalyzerService
from app.config import Settings, load_settings
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
    RecognizerInfo,
    RecognizersResponse,
    RedactRequest,
    RedactResponse,
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

    # Order matters: size limit first (cheapest reject), then correlation, then access log.
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(CorrelationIdMiddleware)
    app.add_middleware(RequestSizeLimitMiddleware, max_bytes=cfg.max_request_bytes)

    app.mount("/metrics", metrics_asgi_app())

    def get_analyzer(req: Request) -> AnalyzerService:
        return req.app.state.analyzer

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
            recognizers=[RecognizerInfo(**r) for r in a.list_recognizers()],
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
        spans = a.analyze(body.text, language=body.language, entities=body.entities)
        for s in spans:
            ENTITIES_DETECTED.labels(entity_type=s.entity_type).inc()
        tokenizer = RequestTokenizer()
        redacted, allocations = tokenizer.redact(body.text, spans)
        return RedactResponse(
            redacted_text=redacted,
            spans=[EntitySpanModel(**s.__dict__) for s in spans],
            tokens=[TokenMapEntry(**a.__dict__) for a in allocations],
        )

    return app


app = create_app()
