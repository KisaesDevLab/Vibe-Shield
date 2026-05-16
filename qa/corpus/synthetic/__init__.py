"""Synthetic QA corpus."""

from qa.corpus.synthetic.bookkeeping import (
    CorpusFixture,
    ExpectedSpan,
    bookkeeping_fixtures,
)
from qa.corpus.synthetic.statements import statement_fixtures


def all_fixtures() -> tuple[CorpusFixture, ...]:
    """Concatenated v1.1 corpus: bookkeeping + statements."""
    return bookkeeping_fixtures() + statement_fixtures()


__all__ = [
    "CorpusFixture",
    "ExpectedSpan",
    "all_fixtures",
    "bookkeeping_fixtures",
    "statement_fixtures",
]
