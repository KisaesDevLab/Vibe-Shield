"""Test that PII-bearing dataclasses mask cleartext in their __repr__.

v1.1.3 §review (R1.14, R1.3): the default dataclass repr would print
cleartext if anything stringifies a TokenAllocation or
ImageRedactionResult. Both have custom __repr__ overrides that mask
the cleartext (token + entity_type + lengths only).
"""

from __future__ import annotations

from app.image.pipeline import ImageRedactionResult, MaskedRegion
from app.tokenizer import TokenAllocation


def test_token_allocation_repr_masks_cleartext() -> None:
    allocation = TokenAllocation(
        token="<US_SSN_1>",
        entity_type="US_SSN",
        cleartext="234-56-7890",  # MUST NOT appear in repr
    )
    r = repr(allocation)
    assert "234-56-7890" not in r
    assert "<US_SSN_1>" in r
    assert "US_SSN" in r
    # length hint is fine to expose
    assert "len=11" in r


def test_token_allocation_repr_masks_long_cleartext() -> None:
    allocation = TokenAllocation(
        token="<PERSON_1>",
        entity_type="PERSON",
        cleartext="A very long sensitive value with names@example.com",
    )
    r = repr(allocation)
    assert "names@example.com" not in r
    assert "A very long" not in r


def test_image_redaction_result_repr_masks_tokens() -> None:
    result = ImageRedactionResult(
        image_sha256="a" * 64,
        masked_image_sha256="b" * 64,
        masked_image_bytes=b"\x89PNG\r\n\x1a\nbinary-payload-here",
        redacted_text="Customer <PERSON_1> account <US_BANK_ACCOUNT_1>",
        tokens=(
            ("<PERSON_1>", "PERSON", "Maria Reyes"),  # cleartext MUST NOT leak
            ("<US_BANK_ACCOUNT_1>", "US_BANK_ACCOUNT", "000123456789"),
        ),
        masked_regions=(
            MaskedRegion(
                entity_type="PERSON",
                token="<PERSON_1>",
                x=0, y=0, width=10, height=10,
            ),
        ),
    )
    r = repr(result)
    assert "Maria Reyes" not in r
    assert "000123456789" not in r
    # binary image bytes should not be in the repr either (avoid huge logs)
    assert b"binary-payload-here".decode() not in r
    # counts are fine
    assert "2 entries" in r
    assert "1 regions" in r
    # hashes are fine
    assert "a" * 64 in r
