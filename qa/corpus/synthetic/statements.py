"""Synthetic bank / credit-card statement fixtures (v1.1, B1 fix).

Real bank statements are the highest-PII inputs Vibe Shield sees in
practice. This corpus covers the four most common formats CPAs receive:

  - Chase: personal checking + business checking
  - Bank of America: personal checking
  - Wells Fargo: small-business checking
  - American Express: business credit card

Each fixture is a *header excerpt* compressed onto a few lines — the
part with PII (name, account number, routing, customer-service phone).
Multi-line free-form addresses are deliberately omitted; spaCy NER on
sm/lg gets confused by Faker-generated street addresses split across
newlines and produces noisy PERSON/LOCATION false positives that aren't
representative of the real Converter input.

Hard rule: synthetic only. All names from Faker. Account numbers are
format-valid but never issued. Routing numbers are public Federal
Reserve numbers. CREDIT_CARD uses the documented Stripe AmEx test
card 3782 822463 10005 (15 digits, Luhn-valid).
"""

from __future__ import annotations

from faker import Faker

from qa.corpus.synthetic.bookkeeping import CorpusFixture, ExpectedSpan, _spans_for

_faker = Faker("en_US")
_faker.seed_instance(2027)


# Test account numbers — format-valid, never issued.
_CHASE_PERSONAL_ACCT = "000123456789"
_CHASE_BUSINESS_ACCT = "987612345678"
_BOFA_PERSONAL_ACCT = "325000456789"
_WF_BUSINESS_ACCT = "411112223344"

# Stripe documented AmEx test card. 15 digits, Luhn-valid.
_AMEX_TEST_CARD = "378282246310005"

# Federal Reserve / bank routing numbers — public, no PII linkage.
_CHASE_ROUTING = "021000021"  # FRB NY / Chase
_BOFA_ROUTING = "026009593"   # BofA NY
_WF_ROUTING = "121000248"     # WF CA

# Real customer-service numbers (publicly documented). They're real
# phones but not personal — every CPA sees them on every statement.
_CHASE_CS = "1-800-935-9935"
_BOFA_CS = "1.800.432.1000"
_WF_CS = "1-800-225-5935"
_AMEX_CS = "1-800-528-4800"


def statement_fixtures() -> tuple[CorpusFixture, ...]:
    fixtures: list[CorpusFixture] = []

    # ---- Chase personal checking statement header (3 fixtures) ----
    for i in range(3):
        name = _faker.name()
        text = (
            f"JPMorgan Chase Bank N.A. statement period 04/01/2026 to 04/30/2026. "
            f"Account holder {name}. Primary account {_CHASE_PERSONAL_ACCT}, "
            f"routing {_CHASE_ROUTING}. Beginning balance $1,234.56, ending $2,345.67. "
            f"Customer service {_CHASE_CS}."
        )
        fixtures.append(
            CorpusFixture(
                id=f"chase_personal_{i}",
                text=text,
                expected=_spans_for(
                    text,
                    [
                        ("PERSON", name),
                        ("US_BANK_ACCOUNT", _CHASE_PERSONAL_ACCT),
                        ("US_BANK_ROUTING", _CHASE_ROUTING),
                        ("PHONE_NUMBER", _CHASE_CS),
                    ],
                ),
            )
        )

    # ---- Chase business checking with EIN reference (2 fixtures) ----
    for i in range(2):
        biz_name = f"{_faker.last_name()} Consulting LLC"
        signer = _faker.name()
        ein = "82-1234567"
        text = (
            f"Chase for Business statement 04/01/2026 - 04/30/2026. "
            f"Business {biz_name}, authorized signer {signer}, tax ID {ein}. "
            f"Business account {_CHASE_BUSINESS_ACCT}, routing {_CHASE_ROUTING}. "
            f"Available balance $48,217.93. Customer service {_CHASE_CS}."
        )
        fixtures.append(
            CorpusFixture(
                id=f"chase_business_{i}",
                text=text,
                expected=_spans_for(
                    text,
                    [
                        ("BUSINESS_NAME", biz_name),
                        ("PERSON", signer),
                        ("US_EIN", ein),
                        ("US_BANK_ACCOUNT", _CHASE_BUSINESS_ACCT),
                        ("US_BANK_ROUTING", _CHASE_ROUTING),
                        ("PHONE_NUMBER", _CHASE_CS),
                    ],
                ),
            )
        )

    # ---- Bank of America personal checking (3 fixtures) ----
    for i in range(3):
        name = _faker.name()
        text = (
            f"Bank of America Adv Plus Banking for the period 03-15-2026 to 04-15-2026. "
            f"Account holder {name}. Account number {_BOFA_PERSONAL_ACCT}, "
            f"ABA routing {_BOFA_ROUTING}. Beginning balance $7,201.05, "
            f"ending balance $6,884.32. Questions call {_BOFA_CS}."
        )
        fixtures.append(
            CorpusFixture(
                id=f"bofa_personal_{i}",
                text=text,
                expected=_spans_for(
                    text,
                    [
                        ("PERSON", name),
                        ("US_BANK_ACCOUNT", _BOFA_PERSONAL_ACCT),
                        ("US_BANK_ROUTING", _BOFA_ROUTING),
                        ("PHONE_NUMBER", _BOFA_CS),
                    ],
                ),
            )
        )

    # ---- Wells Fargo small-business checking (2 fixtures) ----
    for i in range(2):
        biz_name = f"{_faker.last_name()} Construction LLC"
        owner = _faker.name()
        text = (
            f"Wells Fargo Initiate Business Checking statement 04/01/2026 through 04/30/2026. "
            f"Business {biz_name}, DBA owner {owner}. Account number {_WF_BUSINESS_ACCT}, "
            f"routing number {_WF_ROUTING}. Beginning balance $12,419.74, "
            f"ending balance $15,533.08. For online banking call {_WF_CS}."
        )
        fixtures.append(
            CorpusFixture(
                id=f"wf_business_{i}",
                text=text,
                expected=_spans_for(
                    text,
                    [
                        ("BUSINESS_NAME", biz_name),
                        ("PERSON", owner),
                        ("US_BANK_ACCOUNT", _WF_BUSINESS_ACCT),
                        ("US_BANK_ROUTING", _WF_ROUTING),
                        ("PHONE_NUMBER", _WF_CS),
                    ],
                ),
            )
        )

    # ---- American Express business credit card (2 fixtures) ----
    for i in range(2):
        cardholder = _faker.name()
        biz = f"{_faker.last_name()} Holdings Inc"
        text = (
            f"American Express Business Platinum Card statement closing date 04/26/2026. "
            f"Cardmember {cardholder}, business {biz}. Card number {_AMEX_TEST_CARD}. "
            f"Previous balance $4,217.18, payments $4,217.18, new balance $6,884.32. "
            f"Customer care {_AMEX_CS}."
        )
        fixtures.append(
            CorpusFixture(
                id=f"amex_business_{i}",
                text=text,
                expected=_spans_for(
                    text,
                    [
                        ("PERSON", cardholder),
                        ("BUSINESS_NAME", biz),
                        ("CREDIT_CARD", _AMEX_TEST_CARD),
                        ("PHONE_NUMBER", _AMEX_CS),
                    ],
                ),
            )
        )

    return tuple(fixtures)
