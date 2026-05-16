"""End-to-end tests for the v1.1 image-redaction backends.

Generates synthetic test images at runtime (PIL-rendered text + OpenCV-
synthesized "face" + qrcode-generated QR) so the corpus stays tiny in
git. Tests skip cleanly when the underlying system dependency
(tesseract binary, libzbar) isn't installed locally — production CI runs
the engine Docker image where everything is present.
"""

from __future__ import annotations

import io
import shutil

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from app.image import (
    BARCODE_TOKEN,
    FACE_TOKEN,
    HaarFaceDetector,
    PyzbarBarcodeDetector,
    TesseractOcrBackend,
    apply_solid_black_mask,
)
from app.image.pipeline import MaskedRegion

# ---- Skip helpers --------------------------------------------------

_HAS_TESSERACT = shutil.which("tesseract") is not None


def _has_libzbar() -> bool:
    try:
        from pyzbar import pyzbar

        # libzbar is dlopen'd at first use; force a probe by decoding an
        # empty array.
        pyzbar.decode(np.zeros((10, 10, 3), dtype=np.uint8))
    except Exception:
        return False
    return True


_HAS_ZBAR = _has_libzbar()


# ---- Test image generation -----------------------------------------


def _render_text_png(text: str, size: tuple[int, int] = (640, 80)) -> bytes:
    """Render text to a PNG. Tesseract reliably reads the default
    PIL bitmap font when rendered at this size; no external font file."""
    img = Image.new("RGB", size, color="white")
    draw = ImageDraw.Draw(img)
    try:
        # Use the default PIL bitmap font scaled up via repeated draws
        # for legibility (the default is tiny). On systems with truetype
        # available, prefer a real font for higher OCR confidence.
        font = ImageFont.truetype("DejaVuSans.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
    draw.text((10, 20), text, fill="black", font=font)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def _render_qr_png(payload: str) -> bytes:
    """Render a QR code containing payload."""
    qrcode = pytest.importorskip("qrcode")
    img = qrcode.make(payload)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


# ---- TesseractOcrBackend ------------------------------------------


@pytest.mark.skipif(not _HAS_TESSERACT, reason="tesseract binary not on PATH")
def test_tesseract_extracts_text_and_bboxes() -> None:
    backend = TesseractOcrBackend()
    img = _render_text_png("ACME LLC EIN 12-3456789")
    result = backend.extract(img)
    assert "EIN" in result.text or "12-3456789" in result.text
    # At least one span returned with non-zero geometry.
    assert any(s.width > 0 and s.height > 0 for s in result.spans)


@pytest.mark.skipif(not _HAS_TESSERACT, reason="tesseract binary not on PATH")
def test_tesseract_returns_empty_for_blank_image() -> None:
    backend = TesseractOcrBackend()
    blank = Image.new("RGB", (200, 100), color="white")
    out = io.BytesIO()
    blank.save(out, format="PNG")
    result = backend.extract(out.getvalue())
    assert result.text == ""
    assert result.spans == ()


def test_tesseract_unreadable_image_fails_closed() -> None:
    from app.image import OcrUnavailable

    backend = TesseractOcrBackend()
    with pytest.raises(OcrUnavailable):
        backend.extract(b"not-an-image")


# ---- apply_solid_black_mask ---------------------------------------


def test_masker_paints_black_over_region() -> None:
    img = _render_text_png("HELLO WORLD")
    region = MaskedRegion(
        entity_type="PERSON",
        token="<PERSON_1>",
        x=0,
        y=0,
        width=200,
        height=50,
    )
    out = apply_solid_black_mask(img, [region])
    masked = Image.open(io.BytesIO(out))
    arr = np.array(masked.convert("RGB"))
    # Top-left 200x50 should be all black; bottom area should be white.
    assert arr[10, 10].tolist() == [0, 0, 0]
    assert arr[60, 220].tolist() == [255, 255, 255]


def test_masker_preserves_image_dimensions() -> None:
    img = _render_text_png("X", size=(123, 45))
    out = apply_solid_black_mask(img, [
        MaskedRegion(entity_type="PERSON", token="<X>", x=5, y=5, width=10, height=10),
    ])
    assert Image.open(io.BytesIO(out)).size == (123, 45)


def test_masker_no_regions_returns_input_unchanged() -> None:
    img = _render_text_png("nothing to mask")
    assert apply_solid_black_mask(img, []) == img


def test_masker_skips_zero_area_regions() -> None:
    img = _render_text_png("HELLO")
    region = MaskedRegion(
        entity_type="PERSON",
        token="<X>",
        x=0, y=0, width=0, height=10,
    )
    # Should not raise; zero-width region is ignored.
    apply_solid_black_mask(img, [region])


# ---- HaarFaceDetector ---------------------------------------------


def test_face_detector_finds_no_faces_in_blank_image() -> None:
    detector = HaarFaceDetector()
    blank = Image.new("RGB", (300, 300), color="white")
    out = io.BytesIO()
    blank.save(out, format="PNG")
    assert detector.detect(out.getvalue()) == []


def test_face_detector_unreadable_image_fails_closed() -> None:
    from app.image import FaceDetectionUnavailable

    detector = HaarFaceDetector()
    with pytest.raises(FaceDetectionUnavailable):
        detector.detect(b"not-an-image")


# ---- PyzbarBarcodeDetector ----------------------------------------


@pytest.mark.skipif(not _HAS_ZBAR, reason="libzbar not installed")
def test_barcode_detector_finds_qr_code() -> None:
    qr_bytes = _render_qr_png("https://example.com/account/12345")
    detector = PyzbarBarcodeDetector()
    regions = detector.detect(qr_bytes)
    assert len(regions) == 1
    r = regions[0]
    assert r.entity_type == "BARCODE"
    assert r.token == BARCODE_TOKEN
    assert r.width > 0 and r.height > 0


@pytest.mark.skipif(not _HAS_ZBAR, reason="libzbar not installed")
def test_barcode_detector_no_barcode_returns_empty() -> None:
    img = _render_text_png("plain text only")
    detector = PyzbarBarcodeDetector()
    assert detector.detect(img) == []


def test_barcode_detector_unreadable_image_fails_closed() -> None:
    from app.image import BarcodeDetectionUnavailable

    detector = PyzbarBarcodeDetector()
    with pytest.raises(BarcodeDetectionUnavailable):
        detector.detect(b"not-an-image")


# ---- ImageRedactor end-to-end -------------------------------------


@pytest.mark.skipif(not _HAS_TESSERACT, reason="tesseract binary not on PATH")
def test_full_pipeline_tesseract_plus_masking_redacts_email() -> None:
    """End-to-end: render an image with PII, run through ImageRedactor
    with real Tesseract + Pillow masking, assert the email region is
    masked black in the output bytes."""
    from app.analyzer import AnalyzerService
    from app.config import Settings
    from app.image import ImageRedactor

    settings = Settings(spacy_model="en_core_web_sm", log_level="warning")
    analyzer = AnalyzerService(spacy_model=settings.spacy_model, language=settings.default_language)
    analyzer.load()

    redactor = ImageRedactor(
        analyzer,
        ocr=TesseractOcrBackend(),
        masker=apply_solid_black_mask,
    )
    img = _render_text_png("Contact admin@example.com today")
    result = redactor.redact(img)

    # Email should appear as a masked region in the result.
    email_regions = [r for r in result.masked_regions if r.entity_type == "EMAIL_ADDRESS"]
    assert email_regions, "EMAIL_ADDRESS not in masked_regions; OCR may have misread"
    # Output bytes must differ from input — masking applied.
    assert result.masked_image_bytes != img
    # Output is a valid PNG that decodes.
    Image.open(io.BytesIO(result.masked_image_bytes)).verify()


@pytest.mark.skipif(not _HAS_ZBAR, reason="libzbar not installed")
def test_full_pipeline_masks_qr_region_with_solid_black() -> None:
    from app.analyzer import AnalyzerService
    from app.config import Settings
    from app.image import ImageRedactor

    settings = Settings(spacy_model="en_core_web_sm", log_level="warning")
    analyzer = AnalyzerService(spacy_model=settings.spacy_model, language=settings.default_language)
    analyzer.load()

    redactor = ImageRedactor(
        analyzer,
        masker=apply_solid_black_mask,
        barcode_detector=PyzbarBarcodeDetector(),
    )
    qr_bytes = _render_qr_png("https://example.com/sensitive")
    result = redactor.redact(qr_bytes)

    barcode_regions = [r for r in result.masked_regions if r.entity_type == "BARCODE"]
    assert len(barcode_regions) == 1
    # Sample the center of the QR — should now be solid black.
    masked = np.array(Image.open(io.BytesIO(result.masked_image_bytes)).convert("RGB"))
    cy = barcode_regions[0].y + barcode_regions[0].height // 2
    cx = barcode_regions[0].x + barcode_regions[0].width // 2
    assert masked[cy, cx].tolist() == [0, 0, 0]


def test_face_token_constant_is_stable() -> None:
    """Pin the sentinel so cross-repo consumers (Converter) don't break."""
    assert FACE_TOKEN == "<PERSON_FACE>"
    assert BARCODE_TOKEN == "<BARCODE>"
