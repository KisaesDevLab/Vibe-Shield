# Vibe Shield — Custom Recognizers

This file documents every recognizer that Vibe Shield adds on top of Presidio's defaults. The build plan requires that **every recognizer change updates this file** with the pattern, the citation for that pattern, and the measured FP/FN rate from the QA corpus.

FP/FN columns are populated by the recall/precision harness (Phase 12). Until that lands, entries read **TBD — Phase 12**.

## Whitelist post-processor

After Presidio analysis, `app.recognizers.whitelists.apply_whitelists()` drops spans whose substring matches:

- **Currency amounts** — `$1,234.56`, `-$50.00`, `1,234.56 USD`
- **Calendar dates** — ISO-8601 (`2024-03-15`) and common US tabular (`MM/DD/YYYY`, `M/D/YY`)
- **Tax-form numbers** — `1099-NEC`, `1099-MISC`, `1099-K`, `W-2`, `W-9`, `1040`, `1065`, `941`, `5500`, `8949`, plus other IRS-published form identifiers (see `app/recognizers/whitelists.py::TAX_FORM_NUMBERS`).

Dates promoted by the `US_DOB` recognizer (with context cues) do not pass through the date whitelist — they carry their own entity type.

---

## Recognizers

| Entity | Module | Pattern | Source | Recall | Precision |
|---|---|---|---|---|---|
| `US_EIN` | `app/recognizers/ein.py` | `\b\d{2}-\d{7}\b` + valid IRS prefix list | IRS, *How EINs Are Assigned* | TBD — Phase 12 | TBD — Phase 12 |
| `US_BANK_ROUTING` | `app/recognizers/aba_routing.py` | 9 contiguous digits, ABA checksum `(3a+7b+c+…) mod 10 == 0` | ABA Routing Number Policy, 1910 (rev. 2016) | TBD — Phase 12 | TBD — Phase 12 |
| `US_BANK_ACCOUNT` | `app/recognizers/bank_account.py` | 4–17 digits with required context cue ("Account #", "Acct", "DDA", "checking", "savings") | Internal — disambiguates from invoice numbers | TBD — Phase 12 | TBD — Phase 12 |
| `US_ITIN` | `app/recognizers/itin.py` | `9\d{2}-(50–65\|70–88\|90–92\|94–99)-\d{4}` | IRS Pub 1915 (ITIN Operations) | TBD — Phase 12 | TBD — Phase 12 |
| `US_DOB` | `app/recognizers/dob.py` | Date shapes (ISO, US slash/dash, written) + context cue ("DOB", "born", "date of birth", "birthday") | Internal — separates DOB from operational dates | TBD — Phase 12 | TBD — Phase 12 |
| `US_DRIVER_LICENSE` | `app/recognizers/drivers_license.py` | Per-state regex table for 15 states + alphanumeric fallback (≥6 chars with ≥1 digit) gated by context | AAMVA CDS D20; state DMV format specs | TBD — Phase 12 | TBD — Phase 12 |
| `BUSINESS_NAME` | `app/recognizers/business_name.py` | 1–5 capitalized words + corporate suffix (LLC, Inc, P.C., PLLC, LP, LLP, Ltd, Corp, Co, Incorporated, Corporation, Company, …) | Internal — complements Presidio's default `ORGANIZATION` for small-business clients without name recognition | TBD — Phase 12 | TBD — Phase 12 |

---

## US_EIN

**Regex.** `\b\d{2}-\d{7}\b`

**Source.** IRS *Apply for an Employer Identification Number (EIN) Online* and the published list of valid two-digit campus prefixes (effective through 2023). EINs whose prefix isn't in `VALID_PREFIXES` are dropped by `validate_result`.

**Context cues.** "EIN", "Employer ID", "Employer Identification", "Federal ID", "FEIN", "Tax ID", "Taxpayer ID", "TIN".

**Known limitations.**
- No detection without the hyphen (`123456789` not matched).
- Prefix list is a snapshot; IRS adds prefixes periodically. Re-check annually per `compliance/annual-review-checklist.md` (Phase 22).
- Bare numbers in dense tables without context default to low confidence; the analyzer threshold (0.4 by default) may drop them. Tune per-tenant in Phase 10.

## US_BANK_ROUTING

**Regex.** `\b\d{9}\b`

**Validation.** `(3·d1 + 7·d2 + d3 + 3·d4 + 7·d5 + d6 + 3·d7 + 7·d8 + d9) mod 10 == 0`.

**Source.** Accuredited Standards Committee X9 / ABA *Routing Number Policy* (1910, rev. 2016).

**Known limitations.**
- Only matches a 9-digit unbroken run. Hyphen- or space-separated routing numbers are not matched on purpose (banks always print them as a 9-digit block).
- `000000000` is checksum-valid; depend on context to suppress it.
- ITIN-shaped strings whose digits happen to checksum will not match because they include hyphens.

## US_BANK_ACCOUNT

**Regex.** Per-call: `\b\d(?:[\d\s-]{2,21}\d)\b`, validated to 4–17 digits after stripping separators.

**Source.** US bank accounts have no published checksum and length varies by institution (most are 8–12 digits, but range 4–17 covers all observed). Without a check digit, context is the only discriminator.

**Required context cues.** "Account", "Acct", "DDA", "checking", "savings", "deposit", "Account #", "Account No". Without one of these in the window, Presidio's default threshold (0.4) drops the match.

**Known limitations.**
- Invoice numbers in the same format are a structural false-positive risk. The QA corpus (Phase 12) deliberately includes invoice-heavy fixtures to measure this.
- IBANs are handled separately by Presidio's `IBAN_CODE`.

## US_ITIN

**Regex.** `\b9\d{2}-\d{2}-\d{4}\b`, `\b9\d{2}\s\d{2}\s\d{4}\b`, `\b9\d{8}\b`. Middle-group validation: `50–65`, `70–88`, `90–92`, `94–99`.

**Source.** IRS Publication 1915, *Understanding Your IRS Individual Taxpayer Identification Number (ITIN)*.

**Known limitations.**
- ITINs and SSNs are visually similar. Presidio's default `US_SSN` recognizer excludes `9xx`-prefixed numbers, so the two recognizers do not collide.

## US_DOB

**Regex.** Four date shapes — numeric `MM/DD/YYYY`, numeric `MM-DD-YYYY`, ISO `YYYY-MM-DD`, written `Month D, YYYY`.

**Source.** Internal — derived from observed DOB notations in engagement letters, intake forms, and W-9s.

**Required context cues.** "DOB", "Date of Birth", "Birthdate", "Born", "Born on", "Birthday". Without context this would tag every date in the document.

**Year-only generalization.** `generalize_to_year(matched_text)` returns the 4-digit year for use by the "strict" policy (Phase 6/10). 2-digit years return `None` rather than guess the century.

## US_DRIVER_LICENSE

**Regex.** General fallback `\b(?=[A-Z\d]{6,13}\b)(?=[A-Z\d]*\d)[A-Z\d]{6,13}\b`. Per-state validation in `STATE_PATTERNS`:

| State | Pattern |
|---|---|
| CA | `[A-Z]\d{7}` |
| NY | `\d{9}\|\d{8}\|[A-Z]\d{7}\|[A-Z]{2}\d{6}` |
| TX | `\d{7,8}` |
| FL, MI | `[A-Z]\d{12}` |
| IL | `[A-Z]\d{11,12}` |
| PA | `\d{8}` |
| OH | `[A-Z]{2}\d{6}` |
| GA | `\d{7,9}` |
| NC | `\d{1,12}` |
| NJ | `[A-Z]\d{14}` |
| VA | `[A-Z]\d{8,11}` |
| WA | `[A-Z*]{1,7}[A-Z\d*]{4,5}` |
| AZ | `[A-Z]\d{8}` |
| MA | `S\d{8}` |

**Source.** Public state DMV format specifications; AAMVA Card Design Specification data element D20.

**Required context cues.** "driver", "driver's license", "DL#", "DL No", "license no", "license number", "lic#", "lic no", "operator".

**Known limitations.**
- Only 15 of 50 states have explicit patterns. Remaining states fall back to the alphanumeric block, which has higher FP risk and depends on context to survive.
- New license formats (REAL ID rollouts) may require pattern updates.

## BUSINESS_NAME

**Regex.** 1–5 capitalized words (allowing `&` / `and`) immediately followed by a corporate suffix from `_SUFFIXES`.

**Source.** Internal. Complements Presidio's default `ORGANIZATION` (spaCy NER), which catches well-known company names but misses small-business clients whose name signal is the suffix alone.

**Known limitations.**
- Multi-language suffixes (S.A., GmbH, K.K.) are not yet covered. v1.5 candidate.
- Ambiguous on phrases like "the LLC" — lowercase suffix is rejected by the leading-capital requirement.

---

## Adding a recognizer (checklist)

1. New file under `apps/engine/app/recognizers/`.
2. Register in `apps/engine/app/recognizers/__init__.py::register_custom_recognizers`.
3. Tests under `apps/engine/tests/test_recognizer_<name>.py` covering positive, negative, and boundary cases.
4. Update this file: pattern, source, context cues, known limitations. Add row to the summary table with `TBD — Phase 12` for FP/FN until the recall harness measures.
5. Open the PR; answer "redaction recall regression run? Y/N" per the PR template.
