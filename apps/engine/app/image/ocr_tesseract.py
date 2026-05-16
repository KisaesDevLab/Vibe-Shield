"""Tesseract OCR backend (v1.1, Phase 17 §3.2).

Uses pytesseract's `image_to_data` to extract per-word text + bounding
boxes in one pass. Hard rule: image bytes never leave this function;
we feed Tesseract the in-memory PIL image and discard it on return.

Failure modes:
  - tesseract binary missing on PATH: pytesseract raises
    ``TesseractNotFoundError``. We re-raise as ``OcrUnavailable`` so the
    pipeline fails closed with an Anthropic-shaped 503.
  - corrupt/unreadable image: PIL raises ``UnidentifiedImageError``.
    Re-raised as ``OcrUnavailable``.

GLM-OCR primary integration is deferred to a separate adapter when the
hosted GLM-OCR endpoint is wired up (Phase 18 cross-repo work).
Tesseract is the shipped default for v1.1 because it runs offline,
matches the Vibe Shield self-hosted posture, and is good enough for the
financial-document and ID-document fixtures the Converter sends.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import pytesseract
from PIL import Image, UnidentifiedImageError
from pytesseract import TesseractNotFoundError

from app.image.pipeline import OcrResult, OcrSpan
from app.logging import get_logger

logger = get_logger("vibe_shield.engine.image.ocr_tesseract")


class OcrUnavailable(RuntimeError):
    """Tesseract not installed or image unreadable. Hard fail-closed
    error: callers must surface as 503, never silently degrade."""


@dataclass(frozen=True)
class TesseractConfig:
    """Tunables for the Tesseract pipeline.

    ``min_word_confidence`` filters out Tesseract's extremely-low-quality
    word detections (it returns -1 for blank lines and 0-100 otherwise).
    Lower values let more noise through; higher values risk dropping
    real PII. The default 30 matches Tesseract's own "good text" floor
    and keeps recall well above the 0.95 threshold on our fixtures.
    """

    language: str = "eng"
    min_word_confidence: int = 30
    page_segmentation_mode: int = 6  # PSM 6 = "Assume a single uniform block of text".


class TesseractOcrBackend:
    """Real OCR backend used in production.

    Stateless apart from a config object — safe to share across requests.
    """

    def __init__(self, config: TesseractConfig | None = None) -> None:
        self.config = config or TesseractConfig()

    def extract(self, image_bytes: bytes) -> OcrResult:
        try:
            with Image.open(io.BytesIO(image_bytes)) as raw:
                # Convert paletted / CMYK / RGBA to RGB so Tesseract sees
                # a consistent format. ``.copy()`` detaches from the file
                # context so we can close the source.
                image = raw.convert("RGB").copy()
        except UnidentifiedImageError as exc:
            logger.error("ocr_image_unreadable", extra={"error_class": type(exc).__name__})
            raise OcrUnavailable("image unreadable") from exc

        try:
            data = pytesseract.image_to_data(
                image,
                lang=self.config.language,
                config=f"--psm {self.config.page_segmentation_mode}",
                output_type=pytesseract.Output.DICT,
            )
        except TesseractNotFoundError as exc:
            logger.error("tesseract_binary_missing")
            raise OcrUnavailable("tesseract binary not on PATH") from exc
        except Exception as exc:
            logger.error("ocr_failed", extra={"error_class": type(exc).__name__})
            raise OcrUnavailable("ocr failed") from exc
        finally:
            image.close()

        spans: list[OcrSpan] = []
        text_chunks: list[str] = []
        # image_to_data returns parallel lists keyed by token index.
        for i, word in enumerate(data.get("text", [])):
            if not word or not word.strip():
                continue
            try:
                conf = int(float(data["conf"][i]))
            except (ValueError, TypeError):
                conf = -1
            if conf < self.config.min_word_confidence:
                continue
            x = int(data["left"][i])
            y = int(data["top"][i])
            w = int(data["width"][i])
            h = int(data["height"][i])
            spans.append(OcrSpan(text=word, x=x, y=y, width=w, height=h))
            text_chunks.append(word)

        # Concatenate with single spaces so character offsets line up
        # with what _spans_to_regions expects (cursor += len(word) + 1).
        return OcrResult(text=" ".join(text_chunks), spans=tuple(spans))
