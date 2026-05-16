"""Image redaction pipeline.

The OCR + masking surface is abstracted behind ``OcrBackend`` so the
production deployment can plug in GLM-OCR (Phase 18 cross-repo) or
Tesseract (v1.1 default) without touching the calling code. v1.0
shipped ``StubOcrBackend``; v1.1 wires Tesseract + Pillow masking +
OpenCV face detection + pyzbar barcode detection.

Hard rules in force:
  - Image bytes never appear in logs (we hash them for audit reference).
  - If OCR, face detection, barcode detection, or masking fails, the
    request fails closed — we do not return a "best effort" redacted
    image.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from app.analyzer import AnalyzerService, EntitySpan
from app.tokenizer import RequestTokenizer, TokenAllocation


@dataclass(frozen=True)
class OcrSpan:
    """One OCR'd word + its bounding box on the source image."""

    text: str
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class OcrResult:
    """OCR output from a backend."""

    text: str
    """Concatenated text, suitable for the standard text recognizer/backstop pipeline."""
    spans: tuple[OcrSpan, ...]
    """Per-word spans + bboxes; needed to map text-space tokens back to image-space masks."""


class OcrBackend(Protocol):
    def extract(self, image_bytes: bytes) -> OcrResult: ...


class StubOcrBackend:
    """Returns no OCR text and no spans. v1.0 default; swapped in v1.1."""

    def extract(self, image_bytes: bytes) -> OcrResult:
        return OcrResult(text="", spans=())


@dataclass(frozen=True)
class MaskedRegion:
    """One masked rectangle in the output image."""

    entity_type: str
    token: str
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class ImageRedactionResult:
    """End-to-end redaction output for one image."""

    image_sha256: str
    """SHA-256 of the *input* bytes — for audit linkage."""
    masked_image_sha256: str
    """SHA-256 of the *output* bytes."""
    masked_image_bytes: bytes
    redacted_text: str
    tokens: tuple[tuple[str, str, str], ...]
    """``(token, entity_type, cleartext)`` per allocation."""
    masked_regions: tuple[MaskedRegion, ...]


class FaceDetector(Protocol):
    """Detects faces in an image; returns regions to mask."""

    def detect(self, image_bytes: bytes) -> list[MaskedRegion]: ...


class BarcodeDetector(Protocol):
    """Detects barcodes/QR codes; returns regions to mask."""

    def detect(self, image_bytes: bytes) -> list[MaskedRegion]: ...


class _NoFaceDetector:
    """v1.0-compatible no-op face detector. Tests that don't care about
    faces inject this; production injects the real Haar detector."""

    def detect(self, _image_bytes: bytes) -> list[MaskedRegion]:
        return []


class _NoBarcodeDetector:
    """No-op barcode detector. Same rationale as _NoFaceDetector."""

    def detect(self, _image_bytes: bytes) -> list[MaskedRegion]:
        return []


class ImageRedactor:
    """End-to-end image-redaction pipeline.

    v1.1: face + barcode detectors run alongside OCR. All three must
    succeed (fail-closed). The masker paints every region — text-derived
    plus face plus barcode — over the original image.
    """

    def __init__(
        self,
        analyzer: AnalyzerService,
        ocr: OcrBackend | None = None,
        masker: Callable[[bytes, list[MaskedRegion]], bytes] | None = None,
        face_detector: FaceDetector | None = None,
        barcode_detector: BarcodeDetector | None = None,
    ) -> None:
        self.analyzer = analyzer
        self.ocr = ocr or StubOcrBackend()
        self.masker = masker or _identity_masker
        self.face_detector = face_detector or _NoFaceDetector()
        self.barcode_detector = barcode_detector or _NoBarcodeDetector()

    def redact(self, image_bytes: bytes) -> ImageRedactionResult:
        ocr = self.ocr.extract(image_bytes)
        spans = self.analyzer.analyze(ocr.text) if ocr.text else []
        tokenizer = RequestTokenizer()
        redacted_text, allocations = tokenizer.redact(ocr.text, spans)

        text_regions = list(_spans_to_regions(spans, ocr.spans, allocations))
        face_regions = self.face_detector.detect(image_bytes)
        barcode_regions = self.barcode_detector.detect(image_bytes)
        all_regions: list[MaskedRegion] = [*text_regions, *face_regions, *barcode_regions]
        masked_bytes = self.masker(image_bytes, all_regions)

        return ImageRedactionResult(
            image_sha256=hashlib.sha256(image_bytes).hexdigest(),
            masked_image_sha256=hashlib.sha256(masked_bytes).hexdigest(),
            masked_image_bytes=masked_bytes,
            redacted_text=redacted_text,
            tokens=tuple((a.token, a.entity_type, a.cleartext) for a in allocations),
            masked_regions=tuple(all_regions),
        )


def _identity_masker(image_bytes: bytes, _regions: list[MaskedRegion]) -> bytes:
    """No-op masker. Used when the caller doesn't want masking applied
    (e.g., the audit-only path) or when the runtime image lacks Pillow.
    Production code wires ``apply_solid_black_mask`` from
    ``app.image.masker`` instead."""
    return image_bytes


def _spans_to_regions(
    text_spans: list[EntitySpan],
    ocr_spans: tuple[OcrSpan, ...],
    allocations: list[TokenAllocation],
) -> list[MaskedRegion]:
    """Map text-offset spans back to OCR bounding boxes.

    Stub-OCR path: ocr_spans is empty so this returns []. Real-OCR
    path (v1.1): walk per-word spans, find which ones overlap each
    text-offset entity span, union their bboxes.
    """
    if not ocr_spans:
        return []
    out: list[MaskedRegion] = []
    cursor = 0
    word_offsets: list[tuple[int, int, OcrSpan]] = []
    for w in ocr_spans:
        word_offsets.append((cursor, cursor + len(w.text), w))
        cursor += len(w.text) + 1  # +1 for separator
    by_token: dict[str, str] = {a.token: a.entity_type for a in allocations}
    for span in text_spans:
        token = next(
            (t for t, et in by_token.items() if et == span.entity_type),
            f"<{span.entity_type}_?>",
        )
        overlapping = [
            w for ws, we, w in word_offsets
            if not (we <= span.start or span.end <= ws)
        ]
        if not overlapping:
            continue
        x = min(w.x for w in overlapping)
        y = min(w.y for w in overlapping)
        right = max(w.x + w.width for w in overlapping)
        bottom = max(w.y + w.height for w in overlapping)
        out.append(MaskedRegion(
            entity_type=span.entity_type,
            token=token,
            x=x,
            y=y,
            width=right - x,
            height=bottom - y,
        ))
    return out
