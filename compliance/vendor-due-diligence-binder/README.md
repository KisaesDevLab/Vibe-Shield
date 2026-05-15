# Vendor Due Diligence Binder

This directory holds the Firm's evidence that the AI provider Vibe Shield uses (Anthropic, PBC) is contractually appropriate for processing CPA-firm client data.

The PDF artifacts below are not committed to the public repo — operators must download the canonical version from each vendor's portal at deployment time and refresh annually per `compliance/annual-review-checklist.md`.

## Required artifacts

| File | Source | Notes |
|---|---|---|
| `anthropic-commercial-terms-<YYYY-MM-DD>.pdf` | https://www.anthropic.com/legal/commercial-terms | Snapshot at the date of last annual review. |
| `anthropic-dpa-<YYYY-MM-DD>.pdf` | Anthropic console (signed) | Must be signed by an authorized Firm representative. |
| `anthropic-zdr-addendum-<YYYY-MM-DD>.pdf` | Anthropic console (if eligible) | Required for the `cpa-bookkeeping-strict`, `tax-research`, and `cpa-converter-output` policies. |
| `anthropic-trust-center-<YYYY-MM-DD>.pdf` | https://trust.anthropic.com | Their SOC 2 + ISO 27001 + HIPAA evidence as of the snapshot date. |
| `kisaesdevlab-confidentiality-commitment.md` | This repo (committed) | Vibe Shield maintainer's confidentiality commitment. |
| `presidio-license-mit.md` | Microsoft Presidio repo | MIT license; Vibe Shield depends on Presidio. |

## Annual refresh

Per the annual-review checklist, every PDF in this binder must be re-snapshotted from the vendor's current portal once per year. The dated filename is the audit trail.

## Why this matters

A peer reviewer or state-board investigator opens this binder first when the question is "is the Firm's vendor due-diligence sufficient under FTC Safeguards Rule §314.4(f)?" The answer needs to be yes, and the evidence needs to be on hand at the moment of the question.
