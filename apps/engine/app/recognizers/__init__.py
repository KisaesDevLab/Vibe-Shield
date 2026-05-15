"""Custom CPA-domain recognizers.

Each recognizer is prefixed ``Vs`` (Vibe Shield) so its class name doesn't
collide with Presidio's predefined recognizer namespace — Presidio
discovers ``PatternRecognizer`` subclasses via ``__subclasses__()`` and
will try to instantiate same-named classes from its default YAML config.

See compliance/recognizers.md for patterns, sources, and known FP/FN
characteristics.
"""

from __future__ import annotations

from presidio_analyzer import AnalyzerEngine

from app.recognizers.aba_routing import VsUsBankRoutingRecognizer
from app.recognizers.bank_account import VsUsBankAccountRecognizer
from app.recognizers.business_name import VsBusinessNameRecognizer
from app.recognizers.dob import VsUsDateOfBirthRecognizer
from app.recognizers.drivers_license import VsUsDriversLicenseRecognizer
from app.recognizers.ein import VsUsEinRecognizer
from app.recognizers.itin import VsUsItinRecognizer


def register_custom_recognizers(analyzer: AnalyzerEngine) -> None:
    """Add every custom Vibe Shield recognizer to the analyzer's registry."""
    registry = analyzer.registry
    for recognizer in (
        VsUsEinRecognizer(),
        VsUsBankRoutingRecognizer(),
        VsUsBankAccountRecognizer(),
        VsUsItinRecognizer(),
        VsUsDateOfBirthRecognizer(),
        VsUsDriversLicenseRecognizer(),
        VsBusinessNameRecognizer(),
    ):
        registry.add_recognizer(recognizer)


__all__ = [
    "VsBusinessNameRecognizer",
    "VsUsBankAccountRecognizer",
    "VsUsBankRoutingRecognizer",
    "VsUsDateOfBirthRecognizer",
    "VsUsDriversLicenseRecognizer",
    "VsUsEinRecognizer",
    "VsUsItinRecognizer",
    "register_custom_recognizers",
]
