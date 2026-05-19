from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import StreamingResponse

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
    RedactPdfPage,
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

    # Lazily-built singleton ImageRedactor. Constructing the Haar
    # cascade + Tesseract config once at app start would be ideal, but
    # we defer until first /redact-image hit so a missing system dep on
    # an /analyze-only deployment doesn't kill startup.
    _image_redactor: dict[str, ImageRedactor | None] = {"value": None}

    def _get_image_redactor(a: AnalyzerService) -> ImageRedactor:
        cached = _image_redactor["value"]
        if cached is not None:
            return cached
        ocr = None
        masker = None
        face_detector = None
        barcode_detector = None
        if cfg.image_ocr_enabled:
            from app.image import (
                TesseractOcrBackend,
                apply_solid_black_mask,
            )

            ocr = TesseractOcrBackend()
            masker = apply_solid_black_mask
        if cfg.image_face_detection_enabled:
            from app.image import HaarFaceDetector

            face_detector = HaarFaceDetector()
        if cfg.image_barcode_detection_enabled:
            from app.image import PyzbarBarcodeDetector

            barcode_detector = PyzbarBarcodeDetector()
        redactor = ImageRedactor(
            a,
            ocr=ocr,
            masker=masker,
            face_detector=face_detector,
            barcode_detector=barcode_detector,
        )
        _image_redactor["value"] = redactor
        return redactor

    @app.post("/redact-image", response_model=RedactImageResponse)
    def redact_image(
        body: dict[str, object],
        a: AnalyzerService = Depends(get_analyzer),
    ) -> RedactImageResponse:
        """Phase 17 image-redaction endpoint (v1.1).

        Accepts ``{"image_base64": <b64>}``. v1.1 wires real backends
        when the engine is configured (``VS_ENGINE_IMAGE_OCR_ENABLED=true``
        etc.); otherwise falls back to the v1.0 stub-OCR + identity-mask
        path so unit tests stay deterministic.

        Hard rule (Phase 17 §3.2): every backend used here fails closed
        — OCR / face / barcode / mask errors raise an EngineUnavailable
        which the ASGI error handler converts to 503.
        """
        b64 = body.get("image_base64", "")
        if not isinstance(b64, str) or not b64:
            raise ValueError("image_base64 is required")
        image_bytes = base64.b64decode(b64)
        redactor = _get_image_redactor(a)
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

    @app.post("/redact-pdf")
    def redact_pdf(
        body: dict[str, object],
        a: AnalyzerService = Depends(get_analyzer),
    ) -> StreamingResponse:
        """v1.5 — multi-page PDF redaction. v1.6 streams.

        Body: ``{"pdf_base64": <b64>, "dpi": <int|default 200>}``.

        Response format (v1.6): newline-delimited JSON.

        - One ``{"type":"page", ...RedactPdfPage}`` line per page,
          emitted *as soon as the page finishes* (not after the whole
          PDF is processed). Lets the gateway forward per-page
          progress to its SSE subscribers in real time.
        - A final ``{"type":"summary", "pdf_sha256": ...,
          "pages_count": N, "tokens_concatenated": [...]}`` line
          carries the cross-page aggregate.

        Content-Type: ``application/x-ndjson``.

        Hard rule: fails closed. Bad PDF / missing poppler / per-page
        error → the stream emits a final ``{"type":"error", ...}``
        line and the connection closes with a 5xx if no bytes have
        been sent yet, or a clean error envelope mid-stream otherwise.
        The gateway treats any ``error`` line as a job failure.
        """
        import hashlib
        import json

        from pdf2image import convert_from_bytes
        from pdf2image.exceptions import (
            PDFInfoNotInstalledError,
            PDFPageCountError,
            PDFSyntaxError,
        )

        b64 = body.get("pdf_base64", "")
        if not isinstance(b64, str) or not b64:
            raise ValueError("pdf_base64 is required")
        dpi_raw = body.get("dpi", 200)
        dpi = int(dpi_raw) if isinstance(dpi_raw, (int, str)) else 200
        if dpi < 72 or dpi > 600:
            raise ValueError("dpi must be between 72 and 600")
        pdf_bytes = base64.b64decode(b64)
        pdf_sha = hashlib.sha256(pdf_bytes).hexdigest()

        # Rasterize up-front so any poppler failure surfaces before we
        # commit to a streaming response (the client can still get a
        # proper 5xx body). Per-page redaction runs lazily in the
        # generator so each page emits its NDJSON line ASAP.
        try:
            images = convert_from_bytes(pdf_bytes, dpi=dpi, fmt="png")
        except (PDFInfoNotInstalledError, PDFPageCountError, PDFSyntaxError) as e:
            raise RuntimeError(f"pdf rasterization failed: {e!s}") from e

        redactor = _get_image_redactor(a)
        total_pages = len(images)

        from collections.abc import Iterator

        def stream() -> Iterator[str]:
            from io import BytesIO

            all_tokens: list[TokenAllocationModel] = []
            try:
                for i, img in enumerate(images, start=1):
                    buf = BytesIO()
                    img.save(buf, format="PNG")
                    page_bytes = buf.getvalue()
                    result = redactor.redact(page_bytes)
                    page = RedactPdfPage(
                        page_number=i,
                        masked_image_sha256=result.masked_image_sha256,
                        masked_image_base64=base64.b64encode(result.masked_image_bytes).decode(
                            "ascii"
                        ),
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
                    all_tokens.extend(page.tokens)
                    yield (
                        json.dumps(
                            {
                                "type": "page",
                                "total_pages": total_pages,
                                **page.model_dump(),
                            }
                        )
                        + "\n"
                    )
                yield (
                    json.dumps(
                        {
                            "type": "summary",
                            "pdf_sha256": pdf_sha,
                            "pages_count": total_pages,
                            "tokens_concatenated": [t.model_dump() for t in all_tokens],
                        }
                    )
                    + "\n"
                )
            except Exception as exc:
                # Mid-stream failure: the gateway sees the error line
                # and marks the job failed. We can't change HTTP status
                # once headers are flushed, so this is the only path.
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "message": f"{type(exc).__name__}: {exc!s}",
                        }
                    )
                    + "\n"
                )

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
        )

    # ------------------------------------------------------------------
    # Phase 26 / v1.8 — Module 2 (Scan).
    #
    # POST /scan accepts a single multipart file (a document or a zip
    # archive) and streams findings back as NDJSON. The gateway
    # pipeline consumes the stream line-by-line, persists scan_files +
    # scan_findings rows, and emits SSE progress events to the SPA.
    #
    # Lines:
    #   {"type":"file_scanned", path, mime, size_bytes, sha256}
    #   {"type":"file_skipped", path, mime, size_bytes, sha256, reason}
    #   {"type":"finding",      path, entity_type, severity, location,
    #                           snippet_redacted, sample_hash}
    #   {"type":"summary",      files_count, findings_count,
    #                           findings_high, findings_medium, findings_low}
    #   {"type":"error",        message}      # mid-stream failure
    #
    # Hard rule: cleartext PII never lands in any of these lines. The
    # snippet redacts the matched span; the cleartext is hashed.
    # ------------------------------------------------------------------
    @app.post("/scan")
    def scan_file(
        file: Annotated[UploadFile, File()],
        source_kind: Annotated[str, Form()] = "file",
        a: AnalyzerService = Depends(get_analyzer),
    ) -> StreamingResponse:
        import json

        from app.scan import (
            ArchiveScanner,
            CsvScanner,
            OfficeDocScanner,
            PdfTextScanner,
            PlainTextScanner,
            ScanContext,
            ScannerRegistry,
            ScanRunner,
        )
        from app.scan.base import FileScanned, FileSkipped, Finding

        body_bytes = file.file.read()
        size_bytes = len(body_bytes)
        mime = file.content_type or "application/octet-stream"
        filename = file.filename or "upload.bin"

        plain = PlainTextScanner()
        csv_s = CsvScanner()
        office = OfficeDocScanner()
        pdf_s = PdfTextScanner()
        # Build the inner-file registry first so the archive scanner
        # can dispatch to it; then add the archive scanner that closes
        # over that same registry.
        inner_registry = ScannerRegistry([csv_s, office, pdf_s, plain])
        archive = ArchiveScanner(inner_registry)
        full_registry = ScannerRegistry([archive, csv_s, office, pdf_s, plain])

        runner = ScanRunner(analyzer=a, registry=full_registry, ctx=ScanContext())

        from collections.abc import Iterator as _Iter
        from io import BytesIO

        def stream() -> _Iter[str]:
            files_count = 0
            findings_count = 0
            findings_by_sev = {"low": 0, "medium": 0, "high": 0}
            try:
                for event in runner.run(filename, BytesIO(body_bytes), size_bytes, mime):
                    if isinstance(event, FileScanned):
                        files_count += 1
                        yield (
                            json.dumps(
                                {
                                    "type": "file_scanned",
                                    "path": event.path,
                                    "mime": event.mime,
                                    "size_bytes": event.size_bytes,
                                    "sha256": event.sha256,
                                }
                            )
                            + "\n"
                        )
                    elif isinstance(event, FileSkipped):
                        files_count += 1
                        yield (
                            json.dumps(
                                {
                                    "type": "file_skipped",
                                    "path": event.path,
                                    "mime": event.mime,
                                    "size_bytes": event.size_bytes,
                                    "sha256": event.sha256,
                                    "reason": event.reason,
                                }
                            )
                            + "\n"
                        )
                    elif isinstance(event, Finding):
                        findings_count += 1
                        if event.severity in findings_by_sev:
                            findings_by_sev[event.severity] += 1
                        else:  # belt-and-braces
                            findings_by_sev["medium"] += 1
                        ENTITIES_DETECTED.labels(entity_type=event.entity_type).inc()
                        yield (
                            json.dumps(
                                {
                                    "type": "finding",
                                    "path": event.path,
                                    "entity_type": event.entity_type,
                                    "severity": event.severity,
                                    "location": event.location,
                                    "snippet_redacted": event.snippet_redacted,
                                    "sample_hash": event.sample_hash,
                                }
                            )
                            + "\n"
                        )
                yield (
                    json.dumps(
                        {
                            "type": "summary",
                            "source_kind": source_kind,
                            "files_count": files_count,
                            "findings_count": findings_count,
                            "findings_high": findings_by_sev["high"],
                            "findings_medium": findings_by_sev["medium"],
                            "findings_low": findings_by_sev["low"],
                        }
                    )
                    + "\n"
                )
            except Exception as exc:
                yield (
                    json.dumps(
                        {
                            "type": "error",
                            "message": f"{type(exc).__name__}: {exc!s}",
                        }
                    )
                    + "\n"
                )

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    return app


app = create_app()
