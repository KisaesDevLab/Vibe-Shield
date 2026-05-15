# Vibe Shield — WISP Section

Drop-in language the firm adds to its **Written Information Security Program** (WISP) to satisfy FTC Safeguards Rule §314.4(c)(3), §314.4(d), §314.4(e), and §314.4(f) coverage of the Vibe Shield deployment. Tested against the 2023 Safeguards Rule amendments and the AICPA *WISP Implementation Guide*.

---

## §1. System overview

The Firm operates **Vibe Shield**, a self-hosted privacy gateway that sits between the Firm's bookkeeping, tax, and document-processing applications and the Anthropic Claude AI service. Shield enforces three controls that the Firm relies on for its FTC Safeguards Rule compliance:

1. **Local PII redaction** before any payload leaves the Firm's infrastructure to a third-party AI provider.
2. **Encrypted-at-rest token vault** holding the cleartext-to-token mappings, under a per-tenant Data Encryption Key wrapped by an appliance-level Key Encryption Key.
3. **Append-only audit log** with row-level immutability triggers, retained for 7 years (matching CPA workpaper retention).

Shield runs on the Firm's Vibe Appliance — Firm-controlled hardware, Firm-controlled network, Firm-administered.

## §2. Coverage map — Safeguards Rule §314.4

| §314.4 element | Vibe Shield control |
|---|---|
| (c)(1) Access controls | Per-app `vs_live_…` API keys; revocable; SHA-256-hashed at rest; never echoed in logs. |
| (c)(2) Inventory of customer information | Token vault is the single source of truth for which client identifiers have been processed by AI; queryable by tenant, session, time window. |
| (c)(3) Encryption | AES-256-GCM for all cleartext at rest in `vs_tokens.cleartext_encrypted`; per-tenant DEK wrapped by appliance KEK; KEK held outside the database. |
| (c)(4) Secure development | Strict-mode TypeScript + Python 3.12, ruff/mypy/pytest/eslint/typecheck on every PR, hard-rule-2 lint blocks direct Anthropic SDK imports outside the gateway, recall/precision CI gate (BUILD_PLAN §12). |
| (c)(5) Authentication | Bearer-token API keys; commercial-key probe at gateway startup; tenant + app resolved from the key. |
| (c)(6) Information disposal | Sessions auto-expire (default 60 min idle); cascade-delete removes vault entries; manual purge endpoint exists; KEK rotation procedure documented in §6 below. |
| (c)(7) Change management | All changes via PR with required CI; CHANGELOG updated per phase. |
| (c)(8) Activity logs | Append-only `vs_audit` table with daily hash-chained digest written to `compliance/audit-digests/<YYYY-MM-DD>.txt`. |
| (d) Pen testing | Annual penetration test scoped against the appliance — see §7. |
| (e) Workforce training | Firm staff receive Shield-specific onboarding; see Firm employee training records. |
| (f) Service provider oversight | Anthropic Commercial Terms + DPA + ZDR addendum on file in the vendor due diligence binder; annual review per §7. |

## §3. Data flow

For every AI-assisted operation, the data flow is:

```
Vibe app (local) ─► Vibe Shield gateway (local)
                     ├─► Engine /redact (local)        — replaces PII with <ENTITY_N> tokens
                     ├─► Token vault (local Postgres)  — encrypted cleartext mapping
                     ├─► Anthropic API (network)        — tokens only; no cleartext
                     └─► Re-identification per policy   — tokens → cleartext, returned to caller
```

**Cleartext PII never crosses the appliance boundary.** The data sent to Anthropic carries only opaque tokens, document structure, and non-identifying content.

## §4. Known noise items (over-redaction)

The following entity types may **over-redact** in v1.0 — they replace non-PII with tokens at a higher rate than the Firm's CPA workflow ideally tolerates. Over-redaction is annoying but never unsafe (no PII leaves the appliance):

- **`US_BANK_ACCOUNT`** — currency amounts adjacent to "Account" context cues sometimes match.
- **`PHONE_NUMBER`** — bare 10-digit runs adjacent to bank account columns sometimes match.

Both are tracked in the v1.1 backlog. See `.shield-build/blockers.md::B1`.

## §5. Materialize endpoint (Converter)

The Vibe Transactions Converter app uses a special endpoint, `POST /v1/sessions/:id/materialize`, that **does** produce cleartext output — but only into a downloaded file the Firm already has the right to (the user is converting their own client's bank statement to OFX). Materialization is:

- Gated to the `cpa-converter-output` policy only; refuses (403) under any other policy
- Audited as a separate event type with the output filename and SHA-256 hash recorded
- Rate-limited per tenant
- Logged to the audit trail before the file is offered for download

## §6. Key management

| Key | Purpose | Storage | Rotation |
|---|---|---|---|
| **VS_KEK** | Wraps every per-tenant DEK | Appliance secret manager; injected via `VS_KEK` env var; never in DB | Annual; manual via documented runbook |
| **DEK (per tenant)** | Encrypts `vs_tokens.cleartext_encrypted` | Wrapped in `vs_tenant_keys.wrapped_dek`; cleartext form lives only in gateway memory for the request lifetime | Per-tenant on incident; otherwise inherits VS_KEK rotation cadence (re-wrapped without re-encrypting tokens) |
| **`vs_live_…` API key** | Per-app credential | SHA-256 hash in `vs_api_keys.key_hash`; cleartext shown to operator exactly once at issue | On personnel change; on suspected compromise; otherwise indefinite |
| **Anthropic API key** | Talks to the AI provider | `ANTHROPIC_API_KEY` env var on the gateway | Annual; on Anthropic Trust Center change; on suspected compromise |

Rotation procedures live in `compliance/incident-response-runbook.md`.

## §7. Annual review

Once per year, the Firm performs:

1. Anthropic Trust Center re-check (download current snapshots into `compliance/vendor-due-diligence-binder/`).
2. KEK rotation per the runbook.
3. Recall/precision recertification: run `qa/recall_precision.py` against the standing corpus and a new partner-reviewed sample of synthetic fixtures; document in `qa/reports/annual-review-<year>.json`.
4. Penetration test scoping with an external assessor.
5. Engagement-letter language re-review against any new state-board guidance.

## §8. Incident response

If the Firm suspects a Vibe Shield compromise:

1. Revoke all `vs_live_…` keys via the admin UI.
2. Stop the gateway container.
3. Rotate `VS_KEK` per the runbook; re-wrap every tenant's DEK.
4. Inspect the audit digest chain (`compliance/audit-digests/`) for any inconsistency in the affected window.
5. If cleartext PII may have reached an unintended party, follow the Firm's standard breach-notification protocol per FTC Safeguards Rule §314.4(j) and applicable state law.

The full runbook is in `compliance/incident-response-runbook.md`.

## §9. Document retention

| Artifact | Retention | Storage |
|---|---|---|
| `vs_audit` rows | 7 years | Postgres token vault |
| Daily audit digests | 7 years | `compliance/audit-digests/` (file system + offline backup) |
| Vendor due-diligence binder | Indefinite | `compliance/vendor-due-diligence-binder/` |
| Engagement letters with the AI disclosure | Per Firm's standard retention (typically 7 years post-engagement) | Firm's existing records system |
| Recall/precision quarterly reports | Indefinite | `qa/reports/` |
