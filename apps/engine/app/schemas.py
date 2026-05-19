from __future__ import annotations

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1)
    language: str | None = None
    entities: list[str] | None = None


class EntitySpanModel(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float


class AnalyzeResponse(BaseModel):
    results: list[EntitySpanModel]


class RedactRequest(BaseModel):
    text: str = Field(min_length=1)
    language: str | None = None
    entities: list[str] | None = None


class TokenMapEntry(BaseModel):
    token: str
    entity_type: str
    # cleartext is included so the gateway can populate the token vault.
    # The engine never logs this field; the gateway must store it encrypted.
    cleartext: str


class RecognizerMissEntry(BaseModel):
    """A backstop catch Presidio missed. Carries no cleartext — only
    entity_type, the backstop name, severity, a SHA-256-truncated
    sample hash, and the span offsets. v1.0.1 routes these to
    ``vs_recognizer_misses`` via the gateway."""

    entity_type: str
    backstop_name: str
    severity: str
    sample_hash: str
    span_start: int
    span_end: int


class RedactResponse(BaseModel):
    redacted_text: str
    spans: list[EntitySpanModel]
    tokens: list[TokenMapEntry]
    misses: list[RecognizerMissEntry] = []


class HealthResponse(BaseModel):
    status: str
    model: str
    model_loaded: bool
    recognizers_count: int
    version: str


class RecognizerInfo(BaseModel):
    name: str
    supported_entities: list[str]
    supported_language: str
    version: str


class RecognizersResponse(BaseModel):
    model: str
    recognizers: list[RecognizerInfo]


class MaskedRegionModel(BaseModel):
    entity_type: str
    token: str
    x: int
    y: int
    width: int
    height: int


class TokenAllocationModel(BaseModel):
    token: str
    entity_type: str
    cleartext: str


class RedactImageResponse(BaseModel):
    """Image-redaction endpoint response. The masked image is returned
    base64-encoded so the API stays JSON-shaped (Phase 17 — slim
    v1.0; v1.1 will add a multipart variant)."""

    image_sha256: str
    masked_image_sha256: str
    masked_image_base64: str
    redacted_text: str
    tokens: list[TokenAllocationModel]
    masked_regions: list[MaskedRegionModel]


class RedactPdfPage(BaseModel):
    """v1.5 — one entry per PDF page after rasterization + redaction."""

    page_number: int
    masked_image_sha256: str
    masked_image_base64: str
    redacted_text: str
    tokens: list[TokenAllocationModel]
    masked_regions: list[MaskedRegionModel]


class RedactPdfResponse(BaseModel):
    """v1.5 — multi-page PDF redaction. The gateway reassembles the
    per-page masked PNGs into a single PDF on its side via pdf-lib;
    the engine just emits the structured per-page data."""

    pdf_sha256: str
    pages_count: int
    pages: list[RedactPdfPage]
    # Concatenated token map across all pages, useful for audit + the
    # extracted.json artifact. Within a single request the tokenizer
    # is per-page, so tokens may repeat (e.g., <PERSON_1>) across
    # pages with different cleartext mappings. Page-scoped tokens are
    # in the per-page entries.
    tokens_concatenated: list[TokenAllocationModel]
