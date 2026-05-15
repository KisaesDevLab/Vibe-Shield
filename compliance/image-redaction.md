# Vibe Shield — Image Redaction

Documentation of Vibe Shield's image-side compliance posture. v1.0 ships the API contract + the stub-OCR implementation; v1.1 wires the real OCR backends and the OpenCV-based masking detectors. Both phases enforce the same contract.

## API contract (stable from v1.0)

`POST /redact-image` — internal-only endpoint on the engine, called by the gateway only.

Request:
```json
{ "image_base64": "<base64-encoded image bytes>" }
```

Response:
```json
{
  "image_sha256": "<hex>",
  "masked_image_sha256": "<hex>",
  "masked_image_base64": "<base64>",
  "redacted_text": "...with <ENTITY_N> tokens...",
  "tokens": [{"token": "<EMAIL_ADDRESS_1>", "entity_type": "EMAIL_ADDRESS", "cleartext": "..."}],
  "masked_regions": [{"entity_type": "EMAIL_ADDRESS", "token": "<EMAIL_ADDRESS_1>", "x": 55, "y": 10, "width": 120, "height": 12}]
}
```

The Converter (addendum 16.5) and any future image-bearing app integrate against this shape today and remain compatible after v1.1's backend swap.

## v1.0 implementation (stub)

- **OCR backend:** `StubOcrBackend` returns empty text; no spans. Callers exercising v1.0 receive a "no detections" result for every image.
- **Masker:** `_identity_masker` returns the input image unchanged.
- **Audit:** the input + output hashes are returned and (when called via the gateway) recorded in `vs_audit` as `materialize`-class events for the Converter flow.

The stub is intentionally honest: a v1.0 deployment that processes an image cannot leak through this endpoint because nothing is detected and nothing is masked. The right v1.0 posture for image-bearing flows is "don't ship images yet — Phase 17 v1.1" — except for the Converter test path, which can integrate against the API contract and switch to the real backend at v1.1 install time without code changes.

## v1.1 plan (OCR + masking)

Three backends, all per-tenant configurable:

1. **GLM-OCR** — primary OCR. Already deployed on most Vibe Appliances per Phase 18.
2. **Tesseract** — fallback OCR. Bundled in the engine Docker image; no network dependency.
3. **OpenCV Haar cascade** — face detection. Sufficient for ID photos, headshots on engagement docs, and check signature regions (in conjunction with the signature heuristic).

Plus:

- **`pyzbar`** for barcode/QR detection. Barcodes on checks and 1099s encode routing/account information; mask by default.
- **Solid-black masker.** Pillow draws an opaque black rectangle over each `MaskedRegion`. Pixelate / blur / token-overlay variants are configured via the per-tenant policy.

## Hard rules in force

1. **Image bytes never appear in logs.** Hashes only.
2. **Fail-closed.** If OCR fails, the request fails. If face detection fails to load, the request fails (no "best effort" masking).
3. **Per-page workflow.** Multi-page PDFs are iterated page-by-page; tokens carry across pages within one session per Phase 6 deterministic tokenization.
4. **Same vault as text.** A `<PERSON_2>` that appears in both an OCR'd image and a transaction memo within one session is the same token. The Converter relies on this.

## Known v1.0 limitations

- No real OCR — all images return empty redaction.
- No face / signature / barcode detection.
- No multipart upload variant; v1.0 is base64-in-JSON only. v1.1 adds multipart for PDFs > a few hundred KB.

## Tests

`apps/engine/tests/test_image_redaction.py`:

- Stub OCR returns empty.
- End-to-end with a fake OCR backend (synthetic word + bbox spans) — proves the bbox mapping is correct from text-offset to image-offset.
- Identity masker returns input unchanged.

When v1.1 wires real backends, the test surface grows to cover face / signature / barcode false-positive and false-negative cases against a synthetic image corpus (analogous to the Phase 12 text corpus).
