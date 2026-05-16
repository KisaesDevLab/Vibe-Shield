"""Cross-type span deconfliction (B1 fix, second half).

Presidio's recognizers cross-fire on the same digit run with different
entity types. A 9-digit ABA routing number ``011000015`` arrives back as:

  US_BANK_ROUTING        score=1.00  [149:158]   <-- correct
  US_DRIVER_LICENSE      score=1.00  [149:158]   <-- false positive
  AU_TFN                 score=1.00  [149:158]   <-- false positive (Australian)
  US_BANK_ACCOUNT        score=0.40  [149:158]   <-- false positive
  US_BANK_NUMBER         score=0.40  [149:158]   <-- alias of BANK_ACCOUNT

Each duplicate counts as a precision-killing FP in the QA harness, even
though the data IS getting redacted (under any of the labels). The fix
isn't to suppress detection — it's to pick one canonical type per
overlapping cluster so we don't double-count.

Algorithm: for each span, drop it if a higher-priority span overlaps it.
Priority is tiered by how specific / context-sensitive the entity type is:

  Tier A (90): SSN, EIN, BANK_ROUTING, EMAIL, DOB, BUSINESS_NAME, US_PASSPORT, US_ITIN, CREDIT_CARD
  Tier B (60): PERSON, LOCATION, BANK_ACCOUNT, IBAN
  Tier C (40): PHONE_NUMBER, URL
  Tier D (10): DATE_TIME, US_DRIVER_LICENSE, BANK_NUMBER (alias), AU_TFN/SG_NRIC_FIN/etc.

DATE_TIME and US_DRIVER_LICENSE land in tier D because Presidio's
recognizers for both fire promiscuously on any digit-shaped string —
phone numbers tagged DATE_TIME, account numbers tagged DRIVER_LICENSE.
Real dates land in protected ranges (currency/date/tax-form module);
real driver-license context never collides with the recognizers we
care about more.

Score is the secondary key: within the same tier, the higher-scoring
span wins. ``US_DOB`` is exempt — already context-promoted.
"""

from __future__ import annotations

from app.analyzer import EntitySpan

# Tier-based priority. Higher number wins. Unknown types default to 50.
_PRIORITY: dict[str, int] = {
    # Tier A — high specificity, low cross-fire risk
    "US_SSN": 90,
    "US_EIN": 90,
    "US_BANK_ROUTING": 90,
    "US_DOB": 90,
    "EMAIL_ADDRESS": 90,
    "BUSINESS_NAME": 90,
    "US_PASSPORT": 90,
    "US_ITIN": 90,
    "CREDIT_CARD": 90,
    # Tier B — moderate specificity
    "PERSON": 60,
    "LOCATION": 60,
    "US_BANK_ACCOUNT": 60,
    "IBAN_CODE": 60,
    # Tier C — lower; recognizers fire on shaped digit runs, often FPs
    "PHONE_NUMBER": 40,
    "URL": 40,
    # Tier D — aliases / non-US patterns / promiscuous recognizers
    "DATE_TIME": 10,  # Presidio fires on any digit run resembling a date
    "US_DRIVER_LICENSE": 10,  # matches any 7-21 digit run; very permissive
    "US_BANK_NUMBER": 10,  # Presidio alias; BANK_ACCOUNT is the canonical
    "AU_TFN": 10,
    "AU_ABN": 10,
    "AU_ACN": 10,
    "AU_MEDICARE": 10,
    "SG_NRIC_FIN": 10,
    "UK_NHS": 10,
    "UK_NINO": 10,
    "IT_FISCAL_CODE": 10,
    "IT_VAT_CODE": 10,
    "IT_IDENTITY_CARD": 10,
    "IT_PASSPORT": 10,
    "IT_DRIVER_LICENSE": 10,
    "ES_NIF": 10,
    "ES_NIE": 10,
    "PL_PESEL": 10,
    "FI_PERSONAL_IDENTITY_CODE": 10,
    "IN_AADHAAR": 10,
    "IN_PAN": 10,
    "IN_PASSPORT": 10,
    "IN_VOTER": 10,
    "IN_VEHICLE_REGISTRATION": 10,
    "KR_RRN": 10,
    "MEDICAL_LICENSE": 10,
    "NRP": 10,
}

_DEFAULT_PRIORITY = 50


def _priority(entity_type: str) -> int:
    return _PRIORITY.get(entity_type, _DEFAULT_PRIORITY)


def _spans_overlap(a: EntitySpan, b: EntitySpan) -> bool:
    return not (a.end <= b.start or b.end <= a.start)


def deconflict_overlapping_spans(spans: list[EntitySpan]) -> list[EntitySpan]:
    """Drop lower-priority spans that overlap a higher-priority span.

    Same-type overlaps are kept (they may be legitimately adjacent /
    nested values; downstream redaction handles them as one region).
    Tie-broken by score (higher wins), then by span width (wider wins).

    Stable: input order preserved among kept spans.
    """
    if not spans:
        return spans

    # Build a sort key per span: higher priority first, higher score
    # second, wider third. We process in dominance order so each span's
    # decision depends only on already-kept spans.
    indexed = list(enumerate(spans))
    indexed.sort(
        key=lambda iv: (
            -_priority(iv[1].entity_type),
            -iv[1].score,
            -(iv[1].end - iv[1].start),
            iv[0],  # stable on input order
        )
    )

    kept_indices: set[int] = set()
    kept_list: list[EntitySpan] = []
    for original_idx, span in indexed:
        # US_DOB is context-promoted; exempt from being dropped.
        if span.entity_type == "US_DOB":
            kept_indices.add(original_idx)
            kept_list.append(span)
            continue
        sp_pri = _priority(span.entity_type)
        dominated = False
        for k in kept_list:
            if span.entity_type == k.entity_type:
                continue  # same-type overlap allowed
            if not _spans_overlap(span, k):
                continue
            k_pri = _priority(k.entity_type)
            if k_pri > sp_pri:
                dominated = True
                break
            if k_pri == sp_pri and k.score > span.score:
                dominated = True
                break
        if not dominated:
            kept_indices.add(original_idx)
            kept_list.append(span)

    # Restore original input order.
    return [sp for i, sp in enumerate(spans) if i in kept_indices]
