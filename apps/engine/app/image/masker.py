"""Pillow-based solid-black masker (v1.1, Phase 17 §3.2).

Takes the input image bytes + a list of MaskedRegions and returns
new bytes with each region painted over with solid black. Preserves
the original image dimensions and re-encodes in the original format
when possible (PNG/JPEG/WebP). Falls back to PNG if the source format
is something we can't round-trip (e.g., animated GIF).

Hard rule: cleartext PII must NEVER end up in the output image. The
masker treats the region list as an authoritative redaction set —
every region gets painted, no exceptions, no "leave a thin border for
visual continuity" softening.
"""

from __future__ import annotations

import io
from collections.abc import Sequence

from PIL import Image, ImageDraw

from app.image.pipeline import MaskedRegion
from app.logging import get_logger

logger = get_logger("vibe_shield.engine.image.masker")

# Output format fallback when the source format isn't PNG/JPEG/WebP.
_FALLBACK_FORMAT = "PNG"

# Solid black mask color. RGB so it works on RGB and RGBA images
# without alpha-channel surprises.
_MASK_COLOR = (0, 0, 0)


def apply_solid_black_mask(image_bytes: bytes, regions: Sequence[MaskedRegion]) -> bytes:
    """Paint solid-black rectangles over each region. Returns the new
    image's bytes. Empty region list → original bytes returned unchanged.
    """
    if not regions:
        return image_bytes

    with Image.open(io.BytesIO(image_bytes)) as raw:
        source_format = raw.format or _FALLBACK_FORMAT
        # Convert paletted / CMYK to RGB so ImageDraw can paint reliably.
        # Preserve RGBA if present so we don't drop transparency on PNGs.
        if raw.mode in ("RGBA", "LA"):
            image = raw.convert("RGBA")
            mask_color: tuple[int, ...] = (*_MASK_COLOR, 255)
        else:
            image = raw.convert("RGB")
            mask_color = _MASK_COLOR

    draw = ImageDraw.Draw(image)
    for r in regions:
        if r.width <= 0 or r.height <= 0:
            continue
        # rectangle bounding box: [x0, y0, x1, y1] inclusive of x0/y0,
        # exclusive of x1/y1 in Pillow ≥10. We pass exclusive coords.
        draw.rectangle(
            [r.x, r.y, r.x + r.width, r.y + r.height],
            fill=mask_color,
        )

    out = io.BytesIO()
    save_format = source_format if source_format in {"PNG", "JPEG", "WEBP"} else _FALLBACK_FORMAT
    save_kwargs: dict[str, object] = {}
    if save_format == "JPEG":
        # Strip alpha for JPEG output; quality 95 preserves OCR-grade clarity.
        if image.mode == "RGBA":
            image = image.convert("RGB")
        save_kwargs["quality"] = 95
        save_kwargs["optimize"] = True
    image.save(out, format=save_format, **save_kwargs)
    return out.getvalue()
