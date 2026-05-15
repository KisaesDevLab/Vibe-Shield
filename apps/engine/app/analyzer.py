"""Presidio analyzer wrapper.

Phase 2 wires up the default Presidio recognizer registry on top of a spaCy
NLP engine. Custom CPA recognizers (Phase 3) and regex backstops (Phase 4)
will plug into this same wrapper.

Fail-closed: if the spaCy model can't be loaded, ``AnalyzerService.load``
raises and the FastAPI lifespan handler refuses to start the app.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict

from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider

from app.logging import get_logger


class RecognizerInfoDict(TypedDict):
    name: str
    supported_entities: list[str]
    supported_language: str
    version: str

logger = get_logger("vibe_shield.engine.analyzer")


@dataclass(frozen=True)
class EntitySpan:
    entity_type: str
    start: int
    end: int
    score: float

    @classmethod
    def from_presidio(cls, r: RecognizerResult) -> EntitySpan:
        return cls(entity_type=r.entity_type, start=r.start, end=r.end, score=r.score)


class AnalyzerService:
    """Holds the loaded AnalyzerEngine. One instance per process."""

    def __init__(self, spacy_model: str, language: str = "en") -> None:
        self.spacy_model = spacy_model
        self.language = language
        self._engine: AnalyzerEngine | None = None
        # Imported lazily in load() to defer the backstops package import
        # until after the recognizers package finished registering.
        from app.backstops import BackstopLayer

        self._backstop_layer = BackstopLayer()

    @property
    def is_loaded(self) -> bool:
        return self._engine is not None

    @property
    def engine(self) -> AnalyzerEngine:
        if self._engine is None:
            raise RuntimeError("analyzer not loaded; call load() first")
        return self._engine

    def load(self) -> None:
        if self._engine is not None:
            return
        provider = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": self.language, "model_name": self.spacy_model}],
            }
        )
        nlp_engine = provider.create_engine()
        # default_score_threshold=0.4 drops low-confidence pattern matches
        # (e.g., bare 4-17 digit runs that look like bank accounts) unless
        # the context-enhancement layer boosts them above 0.4. This is what
        # makes context-required recognizers (US_BANK_ACCOUNT, US_DOB) safe.
        engine = AnalyzerEngine(
            nlp_engine=nlp_engine,
            supported_languages=[self.language],
            default_score_threshold=0.4,
        )
        # Imported here to avoid a circular import (recognizers depends on
        # this module via the EntitySpan reexport pattern).
        from app.recognizers import register_custom_recognizers

        register_custom_recognizers(engine)
        self._engine = engine
        logger.info("analyzer loaded", extra={"model": self.spacy_model})

    def analyze(
        self,
        text: str,
        language: str | None = None,
        entities: list[str] | None = None,
    ) -> list[EntitySpan]:
        """Run the full redaction pipeline. Fail-closed: any internal error
        is raised as ``EngineUnavailable``; the global handler maps it to
        503 without echoing the exception message (which could carry
        cleartext text via library-built error strings).
        """
        # Imports here to avoid circular: errors imports logging; whitelists
        # and backstops import EntitySpan from this module.
        from app.errors import EngineUnavailable
        from app.recognizers.whitelists import apply_whitelists

        try:
            results = self.engine.analyze(
                text=text,
                language=language or self.language,
                entities=entities,
            )
            spans = [EntitySpan.from_presidio(r) for r in results]
        except Exception as exc:
            logger.error(
                "presidio_analyze_failed",
                extra={"error_class": type(exc).__name__},
            )
            raise EngineUnavailable("presidio analysis failed") from exc

        try:
            kept = apply_whitelists(text, spans)
        except Exception as exc:
            logger.error(
                "whitelist_failed",
                extra={"error_class": type(exc).__name__},
            )
            raise EngineUnavailable("whitelist failed") from exc

        try:
            return self._backstop_layer.apply(text, kept)
        except Exception as exc:
            logger.error(
                "backstop_failed",
                extra={"error_class": type(exc).__name__},
            )
            raise EngineUnavailable("backstop failed") from exc

    def list_recognizers(self) -> list[RecognizerInfoDict]:
        # Presidio's Recognizer doesn't ship type stubs — the attribute reads
        # below would all be `Any`. Cast at the boundary so callers see real
        # types.
        out: list[RecognizerInfoDict] = []
        for r in self.engine.registry.recognizers:
            name: str = str(r.name)  # type: ignore[has-type]
            entities: list[str] = [str(e) for e in r.supported_entities]
            lang: str = str(r.supported_language)
            version: str = str(getattr(r, "version", "1.0.0"))
            out.append(
                RecognizerInfoDict(
                    name=name,
                    supported_entities=entities,
                    supported_language=lang,
                    version=version,
                )
            )
        return out
