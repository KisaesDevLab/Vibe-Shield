"""Barcode / QR-code detector via pyzbar (v1.1, Phase 17 §3.2).

Catches PII embedded in barcodes (bank-routing barcodes on checks,
QR codes on payment stubs, account-number 1D codes on statements).
The decoded payload is masked from the image but never logged or
returned to the caller — it goes through the standard tokenizer if it
contains text-shaped PII (handled by the higher-level pipeline).

Hard rules:
  - Decoded barcode payloads NEVER appear in audit logs. Only a
    SHA-256-truncated hash is recorded.
  - Detection failure (libzbar missing, image unreadable) fails closed.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, UnidentifiedImageError
from pyzbar import pyzbar
from pyzbar.pyzbar import ZBarSymbol

from app.image.pipeline import MaskedRegion
from app.logging import get_logger

logger = get_logger("vibe_shield.engine.image.barcode_detector")

# Token sentinel for barcode regions; parallel to FACE_TOKEN.
BARCODE_TOKEN = "<BARCODE>"  # noqa: S105 — sentinel literal, not a credential


class BarcodeDetectionUnavailable(RuntimeError):
    """libzbar missing or image unreadable. Fail closed."""


@dataclass(frozen=True)
class BarcodeHit:
    """Internal: one decoded barcode + its bbox + payload hash.

    The payload itself is dropped before this leaves the module. We
    keep the hash so audit logs can attribute "we masked a barcode here"
    without ever surfacing what it encoded.
    """

    x: int
    y: int
    width: int
    height: int
    symbology: str  # "QRCODE", "CODE128", "EAN13", etc.
    payload_hash: str  # SHA-256 truncated to 16 hex chars


# Symbologies we redact. Includes 1D + 2D + composite. Industrial
# barcodes (PDF417 — driver licenses) are explicitly included; CODE39
# is excluded because banks rarely use it and FP rate on text strings
# is high.
_REDACT_SYMBOLOGIES: tuple[ZBarSymbol, ...] = (
    ZBarSymbol.QRCODE,
    ZBarSymbol.PDF417,
    ZBarSymbol.CODE128,
    ZBarSymbol.EAN13,
    ZBarSymbol.EAN8,
    ZBarSymbol.UPCA,
    ZBarSymbol.UPCE,
    ZBarSymbol.CODABAR,
    ZBarSymbol.I25,
    ZBarSymbol.DATABAR,
    ZBarSymbol.DATABAR_EXP,
)


class PyzbarBarcodeDetector:
    """pyzbar-backed barcode/QR detector. Stateless."""

    def detect(self, image_bytes: bytes) -> list[MaskedRegion]:
        try:
            with Image.open(io.BytesIO(image_bytes)) as raw:
                image = raw.convert("RGB").copy()
        except UnidentifiedImageError as exc:
            logger.error("barcode_image_unreadable", extra={"error_class": type(exc).__name__})
            raise BarcodeDetectionUnavailable("image unreadable") from exc

        try:
            arr = np.array(image)
            decoded = pyzbar.decode(arr, symbols=list(_REDACT_SYMBOLOGIES))
        except Exception as exc:
            logger.error("barcode_detect_failed", extra={"error_class": type(exc).__name__})
            raise BarcodeDetectionUnavailable("barcode detection failed") from exc
        finally:
            image.close()

        regions: list[MaskedRegion] = []
        for d in decoded:
            payload = d.data or b""
            payload_hash = hashlib.sha256(payload).hexdigest()[:16]
            symbology = str(d.type)
            x, y, w, h = d.rect.left, d.rect.top, d.rect.width, d.rect.height
            logger.info(
                "barcode_redacted",
                extra={"symbology": symbology, "payload_hash": payload_hash},
            )
            regions.append(
                MaskedRegion(
                    entity_type="BARCODE",
                    token=BARCODE_TOKEN,
                    x=int(x),
                    y=int(y),
                    width=int(w),
                    height=int(h),
                )
            )
        return regions
