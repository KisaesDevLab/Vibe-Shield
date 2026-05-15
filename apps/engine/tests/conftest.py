"""Test fixtures.

Tests prefer ``en_core_web_sm`` (small, fast). Production Docker uses
``en_core_web_lg`` per BUILD_PLAN.md. Recall characteristics differ — Phase
12's recall/precision suite is the production-grade gate, not these tests.
"""

from __future__ import annotations

import importlib.util
import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.analyzer import AnalyzerService
from app.config import Settings
from app.main import create_app

TEST_SPACY_MODEL = os.environ.get("VS_ENGINE_TEST_SPACY_MODEL", "en_core_web_sm")


def _model_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


requires_model = pytest.mark.skipif(
    not _model_available(TEST_SPACY_MODEL),
    reason=(
        f"spaCy model {TEST_SPACY_MODEL!r} not installed. "
        f"Run: uv run python -m spacy download {TEST_SPACY_MODEL}"
    ),
)


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        spacy_model=TEST_SPACY_MODEL,
        log_level="warning",
        max_request_bytes=4096,
    )


@pytest.fixture(scope="session")
def analyzer(settings: Settings) -> AnalyzerService:
    svc = AnalyzerService(spacy_model=settings.spacy_model, language=settings.default_language)
    if _model_available(settings.spacy_model):
        svc.load()
    return svc


@pytest.fixture()
def client(settings: Settings, analyzer: AnalyzerService) -> Iterator[TestClient]:
    app = create_app(settings=settings, analyzer=analyzer)
    with TestClient(app) as c:
        yield c
