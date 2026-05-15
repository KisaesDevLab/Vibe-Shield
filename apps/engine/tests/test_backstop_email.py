from __future__ import annotations

import pytest

from app.backstops.email import EmailBackstop

bs = EmailBackstop()


def _hits(text: str) -> list[tuple[int, int]]:
    return [(h.start, h.end) for h in bs.find(text)]


@pytest.mark.parametrize(
    "email",
    [
        "jane.doe@example.com",
        "jane+monthly@example.com",
        "j_doe@example.org",
        "j-doe@example.net",
        "first.last@sub.example.com",
        "x@a.co",
        "alerts@firm.example.com",
        "bookkeeper.monthly@acme-co.com",
        "PORTAL.ADMIN@EXAMPLE.NET",
        "1234@numeric-host.com",
        "a.b.c.d@nested.sub.domain.example.com",
        "tax-team@firm.example.com",
        "support+ticket123@vendor.example.com",
        "audit@firm-with-dashes.com",
        "ops@a-b-c-d.example.com",
    ],
)
def test_email_positive(email: str) -> None:
    text = f"Reach {email} for follow-up."
    assert len(_hits(text)) == 1


def test_multiple_emails_in_paragraph() -> None:
    text = (
        "CC: a@example.com, b@example.org, c@sub.example.net for the report. "
        "Reply to d@example.com only."
    )
    assert len(_hits(text)) == 4


def test_email_in_brackets() -> None:
    assert len(_hits("Forward to <ops@example.com> please.")) == 1


@pytest.mark.parametrize(
    "text",
    [
        "Missing domain part: foo@.com",
        "Missing tld: foo@bar",
        "Just an at-sign @ here.",
        "Email-shaped url: @example.com",
        "Trailing dot: foo@example.",
    ],
)
def test_email_negative(text: str) -> None:
    assert _hits(text) == []
