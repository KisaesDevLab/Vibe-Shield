"""Image redaction pipeline.

v1.0 shipped the API surface + per-page workflow + audit-event type
behind a stub OCR. v1.1 wires real backends:

  - ``TesseractOcrBackend``  — text extraction with per-word bboxes
  - ``apply_solid_black_mask`` — Pillow-based solid-black painter
  - ``HaarFaceDetector``     — OpenCV Haar cascade for frontal faces
  - ``PyzbarBarcodeDetector`` — barcode/QR codes via libzbar

GLM-OCR primary integration is deferred to a separate adapter when the
hosted GLM-OCR endpoint is wired (Phase 18 cross-repo work). Tesseract
is the v1.1 default — runs offline, matches the self-hosted posture.
"""

from app.image.barcode_detector import (
    BARCODE_TOKEN,
    BarcodeDetectionUnavailable,
    PyzbarBarcodeDetector,
)
from app.image.face_detector import (
    FACE_TOKEN,
    FaceDetectionUnavailable,
    FaceDetectorConfig,
    HaarFaceDetector,
)
from app.image.masker import apply_solid_black_mask
from app.image.ocr_tesseract import (
    OcrUnavailable,
    TesseractConfig,
    TesseractOcrBackend,
)
from app.image.pipeline import (
    BarcodeDetector,
    FaceDetector,
    ImageRedactionResult,
    ImageRedactor,
    MaskedRegion,
    OcrBackend,
    OcrResult,
    OcrSpan,
    StubOcrBackend,
)

__all__ = [
    "BARCODE_TOKEN",
    "FACE_TOKEN",
    "BarcodeDetectionUnavailable",
    "BarcodeDetector",
    "FaceDetectionUnavailable",
    "FaceDetector",
    "FaceDetectorConfig",
    "HaarFaceDetector",
    "ImageRedactionResult",
    "ImageRedactor",
    "MaskedRegion",
    "OcrBackend",
    "OcrResult",
    "OcrSpan",
    "OcrUnavailable",
    "PyzbarBarcodeDetector",
    "StubOcrBackend",
    "TesseractConfig",
    "TesseractOcrBackend",
    "apply_solid_black_mask",
]
