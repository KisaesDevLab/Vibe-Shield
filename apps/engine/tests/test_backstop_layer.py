from __future__ import annotations

from app.analyzer import EntitySpan
from app.backstops import BackstopLayer, BackstopMiss
from app.backstops.base import BackstopHit, Severity
from tests.conftest import requires_model


def _make_miss_recorder() -> tuple[list[BackstopMiss], object]:
    bucket: list[BackstopMiss] = []
    def handler(miss: BackstopMiss) -> None:
        bucket.append(miss)
    return bucket, handler


class _FakeBackstop:
    name = "fake_ssn"
    entity_type = "US_SSN"
    severity = Severity.BLOCK

    def find(self, text: str) -> list[BackstopHit]:
        # Hard-coded hit at fixed offsets for predictability.
        if "234-56-7890" in text:
            i = text.index("234-56-7890")
            return [
                BackstopHit(
                    entity_type=self.entity_type,
                    start=i,
                    end=i + 11,
                    backstop_name=self.name,
                    severity=self.severity,
                )
            ]
        return []


def test_layer_emits_new_span_when_presidio_missed() -> None:
    bucket, handler = _make_miss_recorder()
    layer = BackstopLayer(backstops=[_FakeBackstop()], miss_handler=handler)
    text = "An SSN-shaped 234-56-7890 the NER pipeline missed."
    out = layer.apply(text, existing_spans=[])
    assert len(out) == 1
    span = out[0]
    assert span.entity_type == "US_SSN"
    assert span.start == text.index("234-56-7890")
    assert span.score == 1.0
    assert len(bucket) == 1
    miss = bucket[0]
    assert miss.entity_type == "US_SSN"
    assert miss.severity is Severity.BLOCK
    assert miss.backstop_name == "fake_ssn"
    assert len(miss.sample_hash) == 16
    # Sample hash must never contain the cleartext.
    assert "234" not in miss.sample_hash


def test_layer_suppresses_overlap_with_existing_presidio_span() -> None:
    bucket, handler = _make_miss_recorder()
    layer = BackstopLayer(backstops=[_FakeBackstop()], miss_handler=handler)
    text = "An SSN 234-56-7890 already detected."
    presidio = [EntitySpan(entity_type="US_SSN", start=7, end=18, score=0.95)]
    out = layer.apply(text, existing_spans=presidio)
    assert out == presidio  # nothing added
    assert bucket == []     # no miss logged


def test_layer_default_backstops_includes_all_six() -> None:
    layer = BackstopLayer()
    names: set[str] = {bs.name for bs in layer.backstops}
    assert names == {
        "ssn_backstop",
        "ein_backstop",
        "routing_backstop",
        "credit_card_backstop",
        "email_backstop",
        "phone_backstop",
    }


def test_layer_emits_one_span_per_unique_match() -> None:
    bucket, handler = _make_miss_recorder()
    layer = BackstopLayer(miss_handler=handler)
    text = "An SSN 234-56-7890 and an email ops@example.com both leaked."
    out = layer.apply(text, existing_spans=[])
    types = {sp.entity_type for sp in out}
    assert "US_SSN" in types
    assert "EMAIL_ADDRESS" in types
    assert len(bucket) == 2


@requires_model
def test_layer_runs_inside_analyzer(client) -> None:  # type: ignore[no-untyped-def]
    # A text where Presidio's email recognizer would normally catch the
    # address; the backstop should NOT double-count via the overlap check.
    r = client.post(
        "/analyze",
        json={"text": "Email jane.doe@example.com about the deadline."},
    )
    types = [s["entity_type"] for s in r.json()["results"]]
    assert types.count("EMAIL_ADDRESS") == 1


def test_layer_sample_hash_is_deterministic_for_same_text() -> None:
    bucket, handler = _make_miss_recorder()
    layer = BackstopLayer(backstops=[_FakeBackstop()], miss_handler=handler)
    layer.apply("First time: 234-56-7890.", existing_spans=[])
    layer.apply("Second time: 234-56-7890.", existing_spans=[])
    assert len(bucket) == 2
    assert bucket[0].sample_hash == bucket[1].sample_hash


def test_layer_sample_hash_differs_for_different_text() -> None:
    bucket, handler = _make_miss_recorder()
    layer = BackstopLayer(miss_handler=handler)
    layer.apply("First: 234-56-7890.", existing_spans=[])
    layer.apply("Second: 345-67-8901.", existing_spans=[])
    assert {m.sample_hash for m in bucket if m.entity_type == "US_SSN"} == {
        bucket[0].sample_hash,
        bucket[1].sample_hash,
    }
    assert len({m.sample_hash for m in bucket if m.entity_type == "US_SSN"}) == 2
