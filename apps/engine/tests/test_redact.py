from __future__ import annotations

from fastapi.testclient import TestClient

from app.analyzer import EntitySpan
from app.tokenizer import RequestTokenizer
from tests.conftest import requires_model


@requires_model
def test_redact_replaces_email(client: TestClient) -> None:
    text = "Email jane.doe@example.com today."
    r = client.post("/redact", json={"text": text})
    assert r.status_code == 200
    body = r.json()
    assert "jane.doe@example.com" not in body["redacted_text"]
    assert any(t["entity_type"] == "EMAIL_ADDRESS" for t in body["tokens"])
    # Token format <ENTITY_N>
    assert any(t["token"].startswith("<EMAIL_ADDRESS_") and t["token"].endswith(">") for t in body["tokens"])


@requires_model
def test_redact_idempotent_within_request(client: TestClient) -> None:
    text = "Email jane.doe@example.com and jane.doe@example.com."
    r = client.post("/redact", json={"text": text})
    body = r.json()
    # Same cleartext within one request collapses to a single token.
    email_tokens = [t for t in body["tokens"] if t["entity_type"] == "EMAIL_ADDRESS"]
    assert len(email_tokens) == 1


def test_tokenizer_handles_overlapping_spans() -> None:
    tk = RequestTokenizer()
    text = "Contact Jane Doe at Jane Doe LLC."
    spans = [
        EntitySpan(entity_type="PERSON", start=8, end=16, score=0.9),
        # Overlapping wider ORG-style span — lower score, should lose.
        EntitySpan(entity_type="ORG", start=20, end=32, score=0.6),
        EntitySpan(entity_type="PERSON", start=20, end=28, score=0.85),
    ]
    out, allocations = tk.redact(text, spans)
    assert "Jane Doe" not in out
    # Two distinct cleartexts of type PERSON — but wait, both are "Jane Doe":
    # deterministic allocation collapses them to one token.
    person_tokens = {a.token for a in allocations if a.entity_type == "PERSON"}
    assert len(person_tokens) == 1


def test_tokenizer_no_spans_returns_text_unchanged() -> None:
    tk = RequestTokenizer()
    out, allocations = tk.redact("nothing to see here", [])
    assert out == "nothing to see here"
    assert allocations == []
