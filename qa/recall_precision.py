"""Recall / precision harness.

BUILD_PLAN §12 thresholds (CI gate per Phase 20):
  - SSN, EIN, routing recall ≥ 0.99
  - PERSON, LOCATION (addresses) recall ≥ 0.95
  - Precision ≥ 0.90 across all entity types

Hit rule: a fixture's expected span (entity_type, text) is satisfied
if the engine returns at least one span of the *same type* whose
substring overlaps the expected substring (or equals it). False
positives are spans the engine returns of a type/region that no
expected span covers.

Usage:
  uv run python -m qa.recall_precision

The script prints a per-entity-type table and writes a JSON report to
qa/reports/<timestamp>.json. Exit code 1 if any threshold fails.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.analyzer import AnalyzerService, EntitySpan
from app.config import Settings
from qa.corpus.synthetic import CorpusFixture, ExpectedSpan, all_fixtures

REPORTS_DIR = Path(__file__).parent / "reports"

THRESHOLDS_RECALL = {
    "US_SSN": 0.99,
    "US_EIN": 0.99,
    "US_BANK_ROUTING": 0.99,
    "US_BANK_ACCOUNT": 0.95,
    "PERSON": 0.95,
    "LOCATION": 0.95,
    "EMAIL_ADDRESS": 0.95,
    "PHONE_NUMBER": 0.95,
    "BUSINESS_NAME": 0.85,  # NER-driven; tighter cap is unrealistic for v1
    "CREDIT_CARD": 0.99,
}

# Precision floor (single value applied per entity type).
PRECISION_FLOOR = 0.90

# v1.1: B1 blocker resolved (see .shield-build/blockers.md). The precision
# floor now applies to every measured entity unconditionally. Kept as an
# empty set so the gate logic below stays uniform.
PRECISION_GATE_EXEMPT: frozenset[str] = frozenset()


@dataclass
class EntityScore:
    entity_type: str
    expected_count: int
    detected_count: int
    true_positives: int
    false_negatives: int
    false_positives: int

    @property
    def recall(self) -> float:
        denom = self.true_positives + self.false_negatives
        return self.true_positives / denom if denom > 0 else 1.0

    @property
    def precision(self) -> float:
        denom = self.true_positives + self.false_positives
        return self.true_positives / denom if denom > 0 else 1.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) > 0 else 0.0


def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return not (a_end <= b_start or b_end <= a_start)


def _expected_spans_with_offsets(
    fixture: CorpusFixture,
) -> list[tuple[ExpectedSpan, int, int]]:
    out: list[tuple[ExpectedSpan, int, int]] = []
    cursor = 0
    for exp in fixture.expected:
        idx = fixture.text.find(exp.text, cursor)
        if idx == -1:
            # If we can't find the substring at the expected forward position,
            # rewind once. (Same substring may appear twice; prefer the first.)
            idx = fixture.text.find(exp.text)
        if idx == -1:
            continue
        out.append((exp, idx, idx + len(exp.text)))
        cursor = idx + len(exp.text)
    return out


def evaluate(
    analyzer: AnalyzerService,
    fixtures: Iterable[CorpusFixture],
) -> dict[str, EntityScore]:
    scores: dict[str, EntityScore] = {}
    for fix in fixtures:
        spans = analyzer.analyze(fix.text)
        expected = _expected_spans_with_offsets(fix)
        # Bucket detected spans by type for matching.
        detected_by_type: dict[str, list[EntitySpan]] = defaultdict(list)
        for sp in spans:
            detected_by_type[sp.entity_type].append(sp)

        # For each expected span, mark TP if any detected span of the
        # same type overlaps; otherwise FN. Track which detected spans
        # were matched so we don't double-count and can compute FP.
        matched_detected: set[int] = set()
        for exp, e_start, e_end in expected:
            score = scores.setdefault(
                exp.entity_type,
                EntityScore(
                    entity_type=exp.entity_type,
                    expected_count=0,
                    detected_count=0,
                    true_positives=0,
                    false_negatives=0,
                    false_positives=0,
                ),
            )
            score.expected_count += 1
            hit = False
            for i, sp in enumerate(detected_by_type[exp.entity_type]):
                gid = id(sp)
                if gid in matched_detected:
                    continue
                if _overlaps(e_start, e_end, sp.start, sp.end):
                    score.true_positives += 1
                    matched_detected.add(gid)
                    hit = True
                    break
            if not hit:
                score.false_negatives += 1
        # Count FP: detected spans not matched to any expected span of
        # the same type. We only score FPs against types we measure
        # (otherwise auxiliary detections like DATE_TIME flood the
        # numbers).
        for et, sps in detected_by_type.items():
            if et not in THRESHOLDS_RECALL:
                continue
            score = scores.setdefault(
                et,
                EntityScore(
                    entity_type=et,
                    expected_count=0,
                    detected_count=0,
                    true_positives=0,
                    false_negatives=0,
                    false_positives=0,
                ),
            )
            for sp in sps:
                score.detected_count += 1
                if id(sp) not in matched_detected:
                    score.false_positives += 1
    return scores


def main() -> int:
    import os
    model = os.environ.get("QA_SPACY_MODEL", "en_core_web_sm")
    settings = Settings(spacy_model=model, log_level="warning")
    analyzer = AnalyzerService(
        spacy_model=settings.spacy_model, language=settings.default_language
    )
    analyzer.load()

    fixtures = all_fixtures()
    scores = evaluate(analyzer, fixtures)

    # Print + serialize.
    report = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "spacy_model": settings.spacy_model,
        "fixture_count": len(fixtures),
        "scores": {et: asdict(s) | {"recall": s.recall, "precision": s.precision, "f1": s.f1} for et, s in sorted(scores.items())},
        "thresholds": {"recall": THRESHOLDS_RECALL, "precision_floor": PRECISION_FLOOR},
    }

    REPORTS_DIR.mkdir(exist_ok=True)
    out_path = REPORTS_DIR / "latest.json"
    out_path.write_text(json.dumps(report, indent=2))

    print(f"\nQA recall/precision — fixture_count={len(fixtures)} model={settings.spacy_model}\n")
    fmt = "{:<22} {:>4} {:>4} {:>4} {:>4} {:>7} {:>7}"
    print(fmt.format("entity_type", "exp", "tp", "fn", "fp", "recall", "prec"))
    print("-" * 60)
    failed = False
    for et, s in sorted(scores.items()):
        print(
            fmt.format(
                et,
                s.expected_count,
                s.true_positives,
                s.false_negatives,
                s.false_positives,
                f"{s.recall:.2f}",
                f"{s.precision:.2f}",
            )
        )
        recall_floor = THRESHOLDS_RECALL.get(et)
        if recall_floor is not None and s.expected_count > 0 and s.recall < recall_floor:
            print(f"  X {et} recall {s.recall:.2f} below threshold {recall_floor}")
            failed = True
        # Skip precision check for entity types we never expect — those
        # are auxiliary detections (e.g., LOCATION when no addresses
        # are in the fixtures). The main precision gate is per-recall-
        # threshold-tracked entity types.
        if (
            s.expected_count > 0
            and et not in PRECISION_GATE_EXEMPT
            and s.precision < PRECISION_FLOOR
        ):
            print(f"  X {et} precision {s.precision:.2f} below floor {PRECISION_FLOOR}")
            failed = True

    print(f"\nReport: {out_path}")
    if failed:
        print("\nQA gate FAILED.")
        return 1
    print("\nQA gate PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
