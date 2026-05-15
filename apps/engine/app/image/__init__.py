"""Image redaction pipeline.

Phase 17 v1.0 ships the API surface + per-page workflow + audit-event
type. Production-grade OCR (GLM-OCR primary, Tesseract fallback) and
face detection (OpenCV Haar) land in v1.1 — see
`.shield-build/open-decisions.md::D6` for the rationale.

The endpoint is fully usable today through the *stub* OCR path:
callers send an image, the engine returns a masked image (currently
identical to the input) + OCR text run through the standard text
pipeline + token map + bbox audit. The structured response shape is
the contract the Converter team builds against; v1.1 swaps in the
real OCR + face detection without changing the API.
"""

from app.image.pipeline import (
    ImageRedactionResult,
    ImageRedactor,
    MaskedRegion,
    OcrBackend,
    OcrResult,
    OcrSpan,
    StubOcrBackend,
)

__all__ = [
    "ImageRedactionResult",
    "ImageRedactor",
    "MaskedRegion",
    "OcrBackend",
    "OcrResult",
    "OcrSpan",
    "StubOcrBackend",
]
