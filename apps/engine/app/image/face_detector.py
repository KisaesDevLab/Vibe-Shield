"""OpenCV Haar-cascade face detector (v1.1, Phase 17 §3.2).

Uses the bundled ``haarcascade_frontalface_default.xml`` cascade that
ships with opencv-python-headless. Good enough for v1.1: catches frontal
photo IDs (driver's license, passport bio page) and selfies in
identity-verification flows. Defers MediaPipe / DNN face detection to
v1.2 when training-data licensing is sorted (see open-decisions.md::D6).

Output: list of MaskedRegions with entity_type ``PERSON_FACE``. The
caller is responsible for unioning these with text-derived regions
before painting.

Hard rule: when face detection fails (cascade file missing, OpenCV
unavailable), fail closed — never return an empty list pretending no
faces were found.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

from app.image.pipeline import MaskedRegion
from app.logging import get_logger

logger = get_logger("vibe_shield.engine.image.face_detector")


class FaceDetectionUnavailable(RuntimeError):
    """Raised when the cascade model is missing or OpenCV can't process
    the image. Hard fail-closed; never silently skip detection."""


@dataclass(frozen=True)
class FaceDetectorConfig:
    """Tunables for OpenCV's detectMultiScale.

    ``scale_factor`` controls how aggressively the image is downsampled
    between cascade levels. ``min_neighbors`` filters out spurious
    single-window hits — higher values reduce FPs but can drop small
    or partially-occluded faces. The defaults below match OpenCV's
    documented "good for most cases" recommendations and produce 0 FPs
    on the synthetic test fixtures (no faces present) while catching
    the test photo ID.
    """

    scale_factor: float = 1.1
    min_neighbors: int = 5
    min_face_size: int = 30  # pixels per side; smaller windows are skipped


# Solid black mask token for face regions. The text pipeline produces
# tokens like <PERSON_3>; faces use a parallel sentinel since they don't
# arrive through the tokenizer.
FACE_TOKEN = "<PERSON_FACE>"  # noqa: S105 — sentinel literal, not a credential


class HaarFaceDetector:
    """OpenCV Haar-cascade face detector. Stateless; safe to share."""

    def __init__(self, config: FaceDetectorConfig | None = None) -> None:
        self.config = config or FaceDetectorConfig()
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"  # type: ignore[attr-defined]
        self._cascade = cv2.CascadeClassifier(cascade_path)
        if self._cascade.empty():
            logger.error("face_cascade_load_failed", extra={"path": cascade_path})
            raise FaceDetectionUnavailable(
                f"OpenCV failed to load Haar cascade from {cascade_path}"
            )

    def detect(self, image_bytes: bytes) -> list[MaskedRegion]:
        try:
            with Image.open(io.BytesIO(image_bytes)) as raw:
                image = raw.convert("RGB").copy()
        except UnidentifiedImageError as exc:
            logger.error("face_image_unreadable", extra={"error_class": type(exc).__name__})
            raise FaceDetectionUnavailable("image unreadable") from exc

        try:
            arr = np.array(image)
            gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
            faces = self._cascade.detectMultiScale(
                gray,
                scaleFactor=self.config.scale_factor,
                minNeighbors=self.config.min_neighbors,
                minSize=(self.config.min_face_size, self.config.min_face_size),
            )
        except Exception as exc:
            logger.error("face_detect_failed", extra={"error_class": type(exc).__name__})
            raise FaceDetectionUnavailable("face detection failed") from exc
        finally:
            image.close()

        regions: list[MaskedRegion] = []
        # detectMultiScale returns ndarray of (x, y, w, h) per face.
        # Empty result is a 0-length tuple, not an empty array, depending
        # on cv2 version — coerce to an iterable.
        for face in faces if hasattr(faces, "__iter__") else []:
            x, y, w, h = (int(v) for v in face)
            regions.append(
                MaskedRegion(
                    entity_type="PERSON_FACE",
                    token=FACE_TOKEN,
                    x=x,
                    y=y,
                    width=w,
                    height=h,
                )
            )
        return regions
