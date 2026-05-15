"""Phase 17 (slim v1.0) image-redaction tests."""

from __future__ import annotations

import base64

from app.image import ImageRedactor, OcrResult, OcrSpan, StubOcrBackend
from app.image.pipeline import _identity_masker
from tests.conftest import requires_model


def test_stub_ocr_returns_empty() -> None:
    backend = StubOcrBackend()
    out = backend.extract(b"fake-image-bytes")
    assert out.text == ""
    assert out.spans == ()


@requires_model
def test_redactor_with_stub_ocr_yields_no_regions(client) -> None:  # type: ignore[no-untyped-def]
    payload = {"image_base64": base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode("ascii")}
    r = client.post("/redact-image", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["image_sha256"]
    assert body["masked_image_sha256"]
    # Stub OCR returns no text → no regions, no tokens.
    assert body["redacted_text"] == ""
    assert body["tokens"] == []
    assert body["masked_regions"] == []


@requires_model
def test_redactor_with_synthetic_ocr_text_runs_text_pipeline(client) -> None:  # type: ignore[no-untyped-def]
    """With a non-stub OCR that returns 'SSN 234-56-7890', the engine
    must tokenize that string just like the regular /redact endpoint."""

    # Construct an in-memory ImageRedactor with a fake OCR backend.
    class _FakeOcr:
        def extract(self, _: bytes) -> OcrResult:
            return OcrResult(
                text="Email jane.doe@example.com today.",
                spans=(
                    OcrSpan(text="Email", x=10, y=10, width=40, height=12),
                    OcrSpan(text="jane.doe@example.com", x=55, y=10, width=120, height=12),
                    OcrSpan(text="today.", x=180, y=10, width=40, height=12),
                ),
            )

    from app.analyzer import AnalyzerService
    from app.config import Settings
    settings = Settings(spacy_model="en_core_web_sm", log_level="warning")
    analyzer = AnalyzerService(spacy_model=settings.spacy_model, language=settings.default_language)
    analyzer.load()

    redactor = ImageRedactor(analyzer, ocr=_FakeOcr())
    result = redactor.redact(b"fake-image-bytes")
    assert "jane.doe@example.com" not in result.redacted_text
    assert any("EMAIL_ADDRESS" in t[1] for t in result.tokens)
    # Bounding box for the email should be derived from the OCR span.
    email_regions = [r for r in result.masked_regions if r.entity_type == "EMAIL_ADDRESS"]
    assert len(email_regions) == 1
    assert email_regions[0].x == 55  # matches OCR span


def test_identity_masker_returns_input_unchanged() -> None:
    payload = b"original-bytes"
    assert _identity_masker(payload, []) == payload
