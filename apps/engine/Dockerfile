# syntax=docker/dockerfile:1.7
#
# Vibe Shield engine — Python 3.12 + FastAPI + Presidio + spaCy en_core_web_lg.
# Multi-stage to keep the runtime image lean. BUILD_PLAN.md target: <2.5 GB.
#
# This image is internal-only. Never publish to a public registry without
# the appliance manifest gating it (Phase 21).

ARG PYTHON_VERSION=3.12-slim-bookworm
ARG SPACY_MODEL=en_core_web_lg

# ---- Stage 1: builder — install deps + download spaCy model ----
FROM python:${PYTHON_VERSION} AS builder

ARG SPACY_MODEL
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fixed version for reproducibility).
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

WORKDIR /build
COPY pyproject.toml uv.lock ./
# Use the committed uv.lock for reproducibility. --no-dev keeps test
# deps (pytest, mypy, ruff) out of the runtime image.
RUN uv sync --frozen --no-dev

# Download the production spaCy model into the synced env.
RUN uv run --no-dev --with pip python -m spacy download ${SPACY_MODEL}

# ---- Stage 2: runtime ----
FROM python:${PYTHON_VERSION} AS runtime

ARG SPACY_MODEL
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    VS_ENGINE_SPACY_MODEL=${SPACY_MODEL} \
    VS_ENGINE_HOST=0.0.0.0 \
    VS_ENGINE_PORT=8000

# v1.1: image-redaction backends. Tesseract for OCR, libzbar for
# barcode/QR decoding, libgl1 / libglib2 for opencv-python-headless'
# native deps. Languages: install eng + osd (orientation/script).
# Total image size delta: ~70 MB; well within the 2.5 GB BUILD_PLAN cap.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-osd \
        libzbar0 \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Enable v1.1 image backends by default in the production image.
ENV VS_ENGINE_IMAGE_OCR_ENABLED=true \
    VS_ENGINE_IMAGE_FACE_DETECTION_ENABLED=true \
    VS_ENGINE_IMAGE_BARCODE_DETECTION_ENABLED=true

# Drop root privileges. The engine never writes to disk in normal operation.
RUN groupadd --system vibe \
    && useradd --system --gid vibe --home /app --shell /usr/sbin/nologin vibe

# uv sync writes the venv at /build/.venv by default; copy that.
COPY --from=builder /build/.venv /opt/venv

WORKDIR /app
COPY --chown=vibe:vibe app ./app

USER vibe

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2).status==200 else 1)"

# Single worker: AnalyzerEngine + spaCy model is ~600 MB resident; one
# process keeps the memory footprint inside the appliance budget. Scale
# horizontally with replicas if needed.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
