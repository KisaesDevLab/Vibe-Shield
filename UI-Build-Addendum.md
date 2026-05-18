# Vibe Shield — Build Plan (UI Build Addendum)

> **Status (2026-05-18):** **Folded into `BUILD_PLAN.md`.** This document is retained in-tree for traceability. The canonical, current plan is `BUILD_PLAN.md`; see its §12 for the mapping of this addendum's sections into the merged phase list. The addendum's §2 single-FastAPI-container architecture was reviewed and **not adopted** — the 3-service split (Node gateway + Python engine + React admin) shipping as of v1.1.5 is canonical. All product-surface content (modules, RBAC, internal API, evidence pack, WISP, breach matrix, licensing) lives under `BUILD_PLAN.md` Phases 23.5–30 with `[addendum X]` cross-references.

**Original status line:** Supersedes `vibe-ocr-ui-addendum.md`. The standalone-OCR-UI addendum is folded into this product as Module 1 (Shield · Redact). Phase-based, Claude Code–executable.

**Tagline:** *The privacy, compliance, and audit layer for the Vibe suite.*

**One-paragraph elevator:** Vibe Shield is the Kisaes appliance product that handles every piece of work that touches client PII before it leaves the firm's environment, plus the paperwork the firm needs to defend its handling of that PII. It is two things in one container: (1) a **standalone web app** firm staff use directly to redact documents, scan files/spreadsheets/email exports for PII, manage vendors, and generate WISP evidence packs; and (2) an **internal HTTP/queue API** that Vibe MyBooks (and later Vibe Trial Balance, Vibe Connect, Vibe Tax Research Chat) call to push their own documents through the same OCR + redaction + Claude-extraction pipeline. One install per firm, one audit log, one WISP, one egress path.

---

## 0. Why this exists as its own product, not a feature of MyBooks

Four reasons that drive the architectural split:

1. **Single source of compliance truth.** A CPA firm running MyBooks + Trial Balance + (eventually) Connect needs one WISP, one vendor-management binder, one audit log, and one place to demonstrate to a peer reviewer or FTC examiner that PII is handled consistently. Putting that into each app means three diverging implementations; putting it into Shield means one.

2. **A single egress path to Anthropic.** Shield is the only Vibe component that talks to `api.anthropic.com` for client documents. MyBooks, Trial Balance, etc. call Shield's local API instead of calling Anthropic directly. That reduces the attack surface to a single TLS-pinned, audited boundary — and means firms have exactly one ZDR + DPA relationship to manage, not one per app.

3. **Standalone value.** Not every firm using Shield needs MyBooks. A tax-only firm that just wants to redact incoming W-9 attachments or generate a WISP can install Shield by itself. This widens the addressable market and gives Shield a clean upgrade path into the broader Vibe suite.

4. **Selling story.** "We redact PII at the page level on your hardware before any AI sees it, with a per-document audit log and a one-click WISP evidence pack" — that's a stronger sales pitch as its own SKU than as a hidden subsystem of a bookkeeping app.

---

## 1. Product surface

Three Shield modules, all sharing one auth model, one database, one audit log, and one egress path.

| # | Module | What it does | Phase range |
|---|---|---|---|
| 1 | **Shield · Redact** | Visual PII redaction on documents (PDF/image/scan) → OCR → Presidio → Claude extraction. Standalone UI + internal API. | Phases A–Q |
| 2 | **Shield · Scan** | Scan files, folders, spreadsheets, CSVs, email exports (mbox/eml/pst) for unredacted PII. No Claude. Local-only. Reports + bulk redact. | Phases R–V |
| 3 | **Shield · Compliance** | Vendor inventory, DPA tracking, BAA tracking, WISP builder, evidence pack export, breach-notification matrix. | Phases W–AA |

Plus four cross-cutting concerns that span all modules:

- **Shield · Identity** (auth, users, RBAC) — Phases B, C
- **Shield · Audit** (append-only event log, retention) — Phases N, Z
- **Shield · Egress** (Anthropic client wrapper, ZDR enforcement, request signing) — Phase G2 (new)
- **Shield · API** (the internal HTTP + BullMQ surface MyBooks consumes) — Phase AB (new)

---

## 2. Architectural overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ vibe-shield container (single Docker image)                          │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ FastAPI on :8080                                                 │ │
│ │   /                  → React SPA (Shield console)                │ │
│ │   /api/auth/*        → magic-link sessions                       │ │
│ │   /api/redact/*      → Module 1                                  │ │
│ │   /api/scan/*        → Module 2                                  │ │
│ │   /api/compliance/*  → Module 3                                  │ │
│ │   /api/internal/*    → service-to-service (MyBooks etc.)         │ │
│ │                        guarded by X-Shield-Service-Key           │ │
│ │   /healthz /readyz /metrics                                      │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│        │                                                             │
│        ▼                                                             │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Pipeline core (rasterize → OCR → Presidio → paint → validate)    │ │
│ │ + Egress wrapper (single point of contact with Anthropic)        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│        │                                                             │
│        ▼                                                             │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ arq worker (Redis-backed) — redact jobs, scan jobs, cron purges  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
         │             │              │
         ▼             ▼              ▼
   postgres:5432   redis:6379    api.anthropic.com
   (shield_db)    (queue+sess)   (only outbound; redacted only)
```

Other Vibe apps consume Shield as a local-network service:

```
   ┌─────────────────────┐   POST /api/internal/redact/sync
   │  vibe-mybooks       │ ──────────────────────────────────►  ┌────────────────┐
   │  (Node 20 worker)   │ ◄──────────────────────────────────  │  vibe-shield   │
   └─────────────────────┘   { redacted_pdf, extracted_json,    │  (this product)│
                              audit_id, request_ids[] }         └────────────────┘
```

The boundary is intentional: MyBooks never holds an Anthropic API key, never sees an unredacted document for longer than its own staging step, and never owns the audit log. Shield owns all of that.

---

## 3. Phase index

Phases A–Q are the OCR-UI work from the prior addendum, renamed and adjusted for Shield. Phases R onward are new.

| Phase | Module | Name | Items |
|-------|--------|------|------|
| A | Shell    | Repo + image scaffolding (renamed vibe-shield)   | 12 |
| B | Identity | Database schema + migrations (Shield DB)         | 11 |
| C | Identity | Auth (magic link, sessions, RBAC)                | 16 |
| D | Redact   | Job model + storage layout                       | 10 |
| E | Redact   | Upload endpoint (sync + enqueue paths)           | 13 |
| F | Redact   | arq worker integration                           | 11 |
| G | Redact   | Pipeline wiring + artifact emission              | 12 |
| G2 | Egress  | Anthropic client wrapper, ZDR enforcement        | 9  |
| H | Redact   | Download endpoints                               | 10 |
| I | Redact   | SSE progress stream                              | 8  |
| J | Console  | React SPA shell, routing, auth screens           | 14 |
| K | Redact   | SPA — upload + dropzone                          | 11 |
| L | Redact   | SPA — job detail + progress UI                   | 12 |
| M | Redact   | SPA — download + history list                    | 10 |
| N | Audit    | Append-only audit log core                       | 10 |
| O | Shell    | Rate limiting + abuse controls                   | 8  |
| P | Shell    | Observability + healthchecks                     | 7  |
| Q | Shell    | Packaging, docs, smoke tests                     | 10 |
| **R** | **Scan**       | **Scanner engine (files, folders, archives)**      | **13** |
| **S** | **Scan**       | **Spreadsheet + CSV + email-export scanners**      | **12** |
| **T** | **Scan**       | **Scan job model + bulk redaction workflows**      | **11** |
| **U** | **Scan**       | **SPA — scan UI (start scan, results, drill-in)**  | **13** |
| **V** | **Scan**       | **Scheduled scans + alerts**                       | **8**  |
| **W** | **Compliance** | **Vendor inventory + DPA/BAA tracking**            | **12** |
| **X** | **Compliance** | **WISP builder (templates + firm config)**         | **13** |
| **Y** | **Compliance** | **Evidence pack export (the marketing moment)**    | **10** |
| **Z** | **Compliance** | **Breach-notification matrix + state config**      | **9**  |
| **AA**| **Compliance** | **SPA — compliance hub**                            | **12** |
| **AB**| **API**        | **Internal service API (MyBooks/Trial Balance)**   | **14** |
| **AC**| **API**        | **MyBooks integration SDK (Node) + migration**     | **10** |
| **AD**| **Shell**      | **Licensing portal hooks (PolyForm tiers)**        | **8**  |
| **AE**| **Shell**      | **Release packaging, upgrade path, smoke matrix**  | **9**  |

**Total: ~370 items.** Phase A–Q (Module 1) is the launchable v1 and matches the OCR-UI addendum item-for-item. Phases R–V (Module 2), W–AA (Module 3), and AB–AE (cross-cutting) are sequenced for v1.5, v2, and v2.5.

---

## 4. Phases A–Q — Shield · Redact (the OCR UI, renamed and rewired)

These phases match the prior `vibe-ocr-ui-addendum.md` with the following deltas applied throughout:

### 4.1 Naming and pathing

| Old name | Shield name |
|---|---|
| `services/vibe-ocr/` | `services/vibe-shield/` |
| Docker image `kisaes/vibe-ocr:1.0` | `kisaes/vibe-shield:1.0` |
| Container hostname `vibe-ocr` | `vibe-shield` |
| `VIBE_OCR_*` env vars | `VIBE_SHIELD_*` env vars |
| Database `vibe_ocr` | `vibe_shield` |
| Data volume `/var/lib/vibe-ocr` | `/var/lib/vibe-shield` |
| Compose volume `vibe-ocr-data` | `vibe-shield-data` |
| Redis DB index `3` | `5` (Shield reserves 5 and 6) |
| Route prefix `/api/upload`, `/api/jobs`, `/api/download` | `/api/redact/upload`, `/api/redact/jobs`, `/api/redact/download` |
| Page title "Vibe OCR" | "Vibe Shield" |
| Sidebar item "Upload" | "Redact" (with sub-items: Upload, Jobs) |

### 4.2 Storage layout

Storage tree gains a module prefix to keep Scan jobs out of Redact jobs:

```
/var/lib/vibe-shield/
├── redact/
│   └── jobs/<job_id>/      (was /jobs/<job_id>/)
│       ├── source.<ext>
│       ├── pages/
│       ├── redacted.pdf
│       ├── extracted.md
│       ├── extracted.json
│       ├── combined.zip
│       └── audit.jsonl
├── scan/
│   └── jobs/<scan_id>/     (Module 2)
├── compliance/
│   └── evidence-packs/<pack_id>/  (Module 3, ephemeral)
└── tmp/
```

### 4.3 RBAC (replaces the single `is_admin` bit from the prior addendum)

Roles are evaluated per-module. A user can be `viewer`, `operator`, or `admin` independently across the three modules, plus a global `org_admin` flag.

| Role | Module 1 (Redact) | Module 2 (Scan) | Module 3 (Compliance) |
|---|---|---|---|
| viewer | list jobs, download own | view scans, no run | view WISP, no edit |
| operator | upload, manage own jobs | start scans, run redactions | edit own sections |
| admin (per-module) | manage all jobs, see audit | manage all scans, schedules | full WISP, vendors, evidence packs |
| org_admin | full | full | full + user mgmt |

Database change vs the original Phase B:
- Drop `users.is_admin`.
- Add `users.is_org_admin bool default false`.
- Add `user_roles (user_id, module enum('redact','scan','compliance'), role enum('viewer','operator','admin'))` with unique `(user_id, module)`.
- Bootstrap admin (Phase B.8) becomes `is_org_admin=true` and gets `admin` in every module by default.

`admin_required` decorator in `app/deps.py` becomes `requires(module, min_role)` — e.g. `requires("redact","operator")`.

### 4.4 Phase G2 — Anthropic client wrapper (NEW, inserts between G and H)

Centralizing every outbound Claude call in one wrapper is the single most defensible thing Shield does. Other modules cannot create an `anthropic.Anthropic()` directly; they must go through `app.egress.claude`.

**G2.1** `app/egress/claude.py` exposes `extract(redacted_pdf_path, prompt_id, audit_ctx) -> ExtractionResult`. Internal callers never see the raw SDK.

**G2.2** ZDR enforcement: on startup, hit `GET https://api.anthropic.com/v1/me` (or the documented organization endpoint) and verify ZDR is enabled. If `VIBE_SHIELD_REQUIRE_ZDR=true` and ZDR is not enabled, refuse to start and log a clear error. This is a hard interlock.

**G2.3** Pinned model registry in `app/egress/models.py`. Only allowlisted model IDs may be passed (default: `claude-haiku-4-5`, `claude-sonnet-4-6`). Adding a new model requires a code change, not an env var.

**G2.4** Pre-flight redaction validator (already implemented in Phase G.4) is re-run by the egress wrapper itself, even when the caller is internal. Defense in depth: a buggy Scan-module call cannot leak by skipping validation.

**G2.5** Every call writes an audit row with `request_id`, byte count, model, prompt template id, token usage (input/output/cache), latency, and outcome.

**G2.6** Prompt template registry (`app/egress/prompts/*.md`) — versioned markdown files; the wrapper picks by `prompt_id` and records the SHA of the template that was used. Lets Kurt prove which prompt produced which extraction six months later.

**G2.7** Outbound HTTP: pin `api.anthropic.com` to a single CA bundle, set explicit timeouts (15s connect, 120s total), disable redirects.

**G2.8** Rate limiting: a small Redis-backed leaky-bucket caps Anthropic spend per minute per firm; configurable via env. Soft cap at 80% triggers a warning event; hard cap at 100% queues calls.

**G2.9** Tests: cannot import `anthropic` in any module other than `app.egress`. Add a `ruff` rule (or a `pytest` boundary test that walks the AST of `app/`) that enforces this.

The Redact module's pipeline (Phase G.6) is updated to call `egress.claude.extract(...)` instead of constructing the SDK client.

### 4.5 SPA shell deltas (Phase J)

The sidebar grows from one item to three:

```
[Redact]      ← Module 1
  Upload
  Jobs
[Scan]        ← Module 2 (greyed out until R ships)
[Compliance]  ← Module 3 (greyed out until W ships)
[Admin]       ← visible to org_admin only
  Users
  Audit
  Settings
```

A "Module not yet installed" empty state ships at v1, so the UI is the same shape forever — adding a module enables nav rather than restructuring the app.

### 4.6 Audit log (Phase N)

The original Phase N stays, with the schema extended:

- `audit_events.module` enum ('redact','scan','compliance','identity','egress','admin') — required.
- `audit_events.actor_type` enum ('user','service','system') — required. `service` is used for calls coming through `/api/internal/*`.
- `audit_events.service_name` text nullable (e.g. `mybooks`, `trial-balance`) — populated when `actor_type='service'`.

Everything else (append-only, no DELETE/UPDATE, bbox hashes not raw text) is unchanged.

### 4.7 What stays exactly as written

All of: Phase A's Dockerfile and supervisord structure (with renames), Phase B's job and artifact tables, Phase C's magic-link flow, Phase D's encrypted-source-at-rest design, Phase E's sync/async upload, Phase F's arq worker, Phase G's pipeline, Phase H's downloads, Phase I's SSE, Phases J–M's React SPA, Phase O's rate limits, Phase P's observability, Phase Q's smoke tests.

The original addendum's §19 acceptance criteria for Module 1 are unchanged.

---

## 5. Phase R — Shield · Scan engine

**Goal:** Let a firm point Shield at a directory, drive, or archive and get back a report of every file that contains unredacted PII, with the option to bulk-redact in place.

**R.1** Scanner abstraction: `app/scan/scanner.py` defines `Scanner` ABC with `supports(mime) -> bool` and `scan(path) -> ScanResult`. Concrete scanners are registered at import time.

**R.2** Built-in scanners at v1:
- `PdfTextScanner` — text-layer PDFs: `pdfplumber.extract_text` per page, run Presidio, collect spans + page numbers.
- `ImagePdfScanner` — image-only PDFs: rasterize, OCR with Tesseract, then Presidio (reuses Redact pipeline up through detection).
- `ImageScanner` — PNG/JPG/TIFF: same as above without rasterization step.
- `PlainTextScanner` — .txt/.md/.log: just Presidio.
- `OfficeDocScanner` — .docx/.pptx: extract text with `python-docx` / `python-pptx`, then Presidio. .doc/.ppt require LibreOffice conversion in the same container — gate behind feature flag because LO bloat is real.

**R.3** Archive handling: `ArchiveScanner` walks `.zip`, `.7z`, `.tar.gz` recursively with a depth limit (default 4) and total-size limit (default 2 GB unpacked). Zip-bomb defense.

**R.4** Single-file dispatch entry point: `scan_one(path) -> ScanResult` picks the right scanner via `python-magic` MIME sniffing.

**R.5** Recursive walk: `scan_path(root, options)` enumerates files breadth-first, applies an include/exclude glob list, skips files larger than 100 MB by default (configurable).

**R.6** Per-file cap: each scanner has a hard 60s timeout enforced via `concurrent.futures` so one corrupt 500-page PDF can't block a whole scan job.

**R.7** Scan result shape:
```python
class Finding:
    file: Path
    entity_type: str          # US_SSN, US_EIN, US_BANK_NUMBER, PERSON, ...
    confidence: float
    page: int | None          # for PDFs
    cell: str | None          # for spreadsheets (A1 notation)
    line: int | None          # for text/CSV
    bbox_hash: str | None     # never raw coordinates if confidence < threshold
    snippet_hash: str         # SHA-256 of ±30 char context — for diffing, not display
```

**R.8** Presidio runs in scan mode with a wider entity set than Redact (adds `IP_ADDRESS`, `MEDICAL_LICENSE`, `URL`, `LOCATION` because firms want to see all of them in scans).

**R.9** Custom recognizers from Redact (EIN, ABA routing, account-with-context) are reused — single config object in `app/pii/recognizers.py`.

**R.10** Memory budget per file: 250 MB hard cap; oversized files (large rasterized PDFs) processed page-by-page, not in bulk.

**R.11** Scan worker integration: arq function `scan_path(scan_job_id)` streams findings into the database as they arrive (don't accumulate in memory).

**R.12** Idempotency: a scan job has a `path_sha256` so re-scanning the same tree updates instead of duplicates.

**R.13** Tests: fixture corpus of synthetic PDFs, DOCX, ZIPs with known PII at known positions; assert recall ≥95% and precision ≥98% on the corpus.

## 6. Phase S — Spreadsheet, CSV, email scanners

**S.1** `SpreadsheetScanner` — `.xlsx`/`.xlsm`/`.ods` via `openpyxl` (xlsx) and `odfpy` (ods). Iterate every cell, every sheet; record `(sheet, A1)` for each finding. Skip pivot tables (treat as derived).

**S.2** `.xls` legacy via `xlrd<2.0` — but only when explicitly enabled, since xlrd is deprecated and brittle.

**S.3** `CsvScanner` — sniff dialect; for each row, scan each cell; record line + column index. Stream-parse for files > 50 MB.

**S.4** Header detection: if the first row looks header-like (low PII probability, mostly short strings), use it to name columns so the report says `column "Account #" row 47` not `column 3 row 47`.

**S.5** `EmlScanner` — `.eml` via `email` stdlib: scan headers (`From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`), body parts, and attachment filenames. Recurse into attachments via the main dispatcher.

**S.6** `MboxScanner` — iterate messages, hand each to the eml scanner. Cap at 100k messages per archive for sanity.

**S.7** `PstScanner` — gated behind a feature flag (requires `libpff-python` which is finicky on slim images). If disabled, return a clear "PST scanning not enabled" message rather than silently skipping. Document the alternative: ask the firm to export Outlook to mbox first.

**S.8** False-positive tuning for spreadsheets: many CPA workbooks have account number columns where finding "lots of 9-digit numbers" is expected. Allow per-column suppression rules persisted on the scan job (`scan_findings_suppressed`).

**S.9** Sensitive-column heuristic: if a column's header matches `(?i)\b(ssn|tin|ein|account|routing)\b`, flag the whole column at a higher severity even if individual cells failed Presidio's pattern match.

**S.10** Date/amount filtering: numeric columns that match currency or date formats are exempted from `US_BANK_NUMBER` over-detection.

**S.11** CSV streaming: handle CSV files up to 5 GB by reading line-by-line; never `pandas.read_csv` an unknown-size CSV.

**S.12** Tests: synthetic xlsx with known SSN in a specific cell; assert it is found and reported with the correct A1 reference.

## 7. Phase T — Scan job model + bulk redaction

**T.1** `scan_jobs` table:
- `id` uuid pk
- `user_id` uuid fk
- `name` text (e.g. "Q1 2026 client files audit")
- `target_kind` enum ('path','upload','archive')
- `target_path_or_id` text
- `status` enum ('pending','running','completed','failed','cancelled')
- `started_at`, `finished_at`, `created_at`, `expires_at`
- `file_count`, `findings_count`, `pii_count_by_type` jsonb
- `progress_pct` smallint

**T.2** `scan_findings` table (high cardinality):
- `id` bigserial pk
- `scan_job_id` uuid fk on delete cascade
- `file_path_hash` bytea (sha-256 of the path; raw path stored once in `scan_files`)
- `file_id` uuid fk -> `scan_files`
- `entity_type` text
- `confidence` real
- `locator` jsonb (page/cell/line)
- `snippet_hash` bytea
- `bbox_hash` bytea nullable
- `severity` enum ('high','medium','low')
- `suppressed` bool default false
- `created_at` timestamptz
- partial index on `(scan_job_id, severity) where suppressed=false`

**T.3** `scan_files` table (the dedupe layer):
- `id` uuid pk
- `scan_job_id` uuid fk
- `path` text (relative to the scan target, NOT absolute)
- `mime` text, `byte_size` int, `mtime` timestamptz
- `scanner` text (e.g. `PdfTextScanner`)
- `error` text nullable
- `finding_count` int

**T.4** Bulk redact endpoint: `POST /api/scan/jobs/<id>/redact` body `{ file_ids[] }`. For each file:
- Copy original to `/var/lib/vibe-shield/redact/jobs/<new_id>/source.<ext>`
- Enqueue normal Redact job
- Record the parent scan job + finding ids in the new Redact job's metadata

**T.5** "Redact in place" option: writes the redacted artifact back over the original at the scan target. Off by default; requires `org_admin` and a confirmation modal that says "this cannot be undone."

**T.6** Cancellation: setting `status='cancelled'` causes the worker to drain after the current file finishes.

**T.7** Concurrency: only one scan job per scan target may run at a time (advisory lock on `path_sha256`).

**T.8** Expiration: scan findings purge after 30 days by default (configurable); the scan job row stays as a summary record with `findings_purged=true`.

**T.9** Export findings as CSV: `GET /api/scan/jobs/<id>/findings.csv` — streams every non-suppressed finding with file path, locator, entity type, confidence.

**T.10** Audit events for `scan.started`, `scan.completed`, `scan.cancelled`, `scan.bulk_redact_initiated`, `scan.finding_suppressed`, `scan.in_place_redact`.

**T.11** Tests: a scan with 1000 findings exports to CSV under 5s; bulk redact of 10 files produces 10 normal Redact jobs linked back to the parent scan.

## 8. Phase U — Scan SPA

**U.1** Route `/scan` is the scan landing page. Empty state with three CTAs: "Scan a path on this server", "Scan an uploaded archive", "Set up a scheduled scan."

**U.2** Path-scan flow: browse-folder modal (server-side directory listing under a configured `VIBE_SHIELD_SCAN_ROOT`); pick a path; preview file count + estimated time; start.

**U.3** Archive-scan flow: drop a `.zip`/`.7z` (≤2 GB) using the same dropzone component from Module 1; start.

**U.4** Scan-in-progress view shares the SSE progress component from Phase I, with a live "files scanned" counter and a rolling "current file" indicator.

**U.5** Scan-results view: filterable table of findings grouped by file. Sort by severity, entity type, file. Pagination at 100 findings per page.

**U.6** Drill-in: click a file → side panel with the per-finding list, locator labels, snippet hash, and a "Redact this file" action.

**U.7** Bulk select + "Redact selected" toolbar.

**U.8** Suppression UX: each finding has a "False positive" link → records suppression with optional reason; suppressed findings disappear from the default view but show in `?show=suppressed`.

**U.9** Compare-runs view: pick two scan jobs of the same target → diff their findings (new, resolved, persistent).

**U.10** Export: "Download findings CSV" prominent in the results header.

**U.11** Empty-state copy when the firm runs a clean scan: "0 findings across 1,247 files. This scan can be added to your WISP evidence pack."

**U.12** Permissions: `requires('scan','viewer')` for read, `'operator'` to start scans, `'admin'` for in-place redact and suppression of others' findings.

**U.13** Tests (Playwright): full scan of a fixture archive completes; findings appear; one suppressed; one bulk-redacted; CSV export downloads.

## 9. Phase V — Scheduled scans + alerts

**V.1** `scheduled_scans` table: `id`, `user_id`, `name`, `cron`, `target_kind`, `target_path`, `enabled`, `last_run_at`, `next_run_at`.

**V.2** arq cron walks `scheduled_scans` every minute, fires due jobs.

**V.3** Alert delivery: SMTP to a configured `VIBE_SHIELD_ALERTS_TO` whenever a scheduled scan finds severity=high findings that weren't present in the previous run.

**V.4** Per-scheduled-scan thresholds: configurable counts that trigger an alert (e.g. "alert if >0 SSNs found in /clients/").

**V.5** Webhook delivery: `VIBE_SHIELD_ALERT_WEBHOOK_URL` for Slack/Discord/Teams integration; signed payload with HMAC.

**V.6** UI: `/scan/schedule` lists schedules; CRUD via a simple form.

**V.7** "Pause schedule" toggle; "Run now" button.

**V.8** Tests: a paused schedule does not fire; manual run works while paused.

---

## 10. Phase W — Shield · Compliance vendor inventory

**Goal:** Replace the "binder in a filing cabinet" with structured records, automate the FTC §314.4(f) "service provider oversight" workflow, and feed the WISP and evidence pack.

**W.1** `vendors` table: `id`, `name`, `category` enum ('ai','cloud','accounting','payroll','email','communications','storage','other'), `website`, `criticality` enum ('low','medium','high','critical'), `data_categories` jsonb (array of canonical PII categories the vendor sees), `added_at`, `archived_at`.

**W.2** `vendor_agreements`: `id`, `vendor_id`, `kind` enum ('msa','dpa','baa','soc2','iso27001','pen_test','other'), `effective_date`, `expires_date`, `attachment_path`, `notes`, `signed_by`, `signed_at`.

**W.3** `vendor_assessments`: `id`, `vendor_id`, `assessor_user_id`, `assessment_date`, `score` smallint (0-100), `notes`, `next_review_due`. Templates per category.

**W.4** `vendor_incidents`: `id`, `vendor_id`, `incident_date`, `disclosed_date`, `severity`, `summary`, `our_data_affected` bool, `notification_required` bool.

**W.5** Pre-seeded vendor templates for the obvious players: Anthropic, AWS, Google Workspace, Microsoft 365, Intuit, Bill.com, Karbon, TaxDome, Gusto, ADP, Rippling — each with `data_categories`, default `criticality`, and links to the vendor's public Trust Center.

**W.6** Anthropic vendor record is auto-created on first boot of Shield with `criticality='high'`, the ZDR-enabled flag captured from the egress healthcheck, and SOC 2 Type II noted as "verify quarterly." This makes the first WISP evidence pack non-empty out of the box.

**W.7** Renewals dashboard: any agreement with `expires_date` within 60 days surfaces on the Compliance home; 30 days = amber, 14 days = red, 0 days = past-due red.

**W.8** Vendor archive workflow: archived vendors stay in history (for audit) but are excluded from active WISP exports.

**W.9** Vendor detail page exposes "Last assessment", "Active agreements", "Open incidents", and a "Review now" button that creates a new assessment record.

**W.10** Bulk import: CSV upload to seed a vendor list from a firm's existing spreadsheet.

**W.11** Audit events `vendor.added`, `vendor.agreement_uploaded`, `vendor.assessment_completed`, `vendor.incident_logged`, `vendor.archived`.

**W.12** Tests: a vendor with no active DPA cannot be marked as the destination of client PII in any other Shield module without a banner warning.

## 11. Phase X — WISP builder

**Goal:** A guided, section-by-section editor that produces a real, examiner-ready WISP document — not a fill-in-the-blanks template the firm has to fight with.

**X.1** `wisps` table: `id`, `firm_id` (single-tenant: derived from `org`), `name`, `version`, `status` enum ('draft','approved','archived'), `approved_by`, `approved_at`, `created_at`.

**X.2** `wisp_sections` table: `id`, `wisp_id`, `slug`, `title`, `body_md`, `order`, `last_edited_by`, `last_edited_at`. Section content is markdown so it renders cleanly in the evidence pack PDF.

**X.3** Section catalog (Pub 4557 / Pub 5708 / FTC Safeguards Rule §314.4 aligned):

1. Firm identification + qualified individual designation
2. Risk assessment summary
3. Information systems inventory (auto-populated from Vendor module)
4. Access controls
5. Data classification and minimization (Shield's redaction story goes here, autogen'd)
6. Encryption in transit and at rest
7. MFA and authentication policy
8. Logging, monitoring, and incident response
9. Service provider oversight (auto-populated from Vendor module)
10. Security awareness training
11. Disposal procedures
12. Annual review and change management
13. Breach notification matrix (auto-populated from Module Z)
14. Appendices: vendor agreements, assessments, scan summaries

**X.4** Each section has a "Suggested content" panel that drafts the section based on what Shield knows (vendor list, scan history, audit log, ZDR posture). Firm edits the draft. Audit logs every edit.

**X.5** Version control: every save is a row in `wisp_section_revisions`; "approve this WISP" snapshots all sections and freezes the version. Approved WISPs are read-only; further edits create v2.

**X.6** Section completeness indicator on a sidebar: green check, amber partial, red empty. Approval requires all sections green.

**X.7** "Compare to last approved version" diff view.

**X.8** Multi-author support: lock indicator if someone else is editing the same section (advisory via Redis).

**X.9** Anonymous example WISPs shipped as starter templates (small CPA firm, mid-size firm, multi-partner firm).

**X.10** Permissions: `requires('compliance','operator')` to edit, `'admin'` to approve.

**X.11** Audit events `wisp.section_edited`, `wisp.approved`, `wisp.archived`.

**X.12** Export to PDF (Phase Y handles this).

**X.13** Tests: editing a section logs an audit event; approving a WISP with an empty required section returns 422.

## 12. Phase Y — Evidence Pack export

**The marketing moment.** One click; one ZIP a firm can hand to its insurance carrier, peer reviewer, FTC examiner, or IRS Stakeholder Liaison.

**Y.1** `POST /api/compliance/evidence-packs` body `{ wisp_id, include_scans: bool, include_redact_audit: bool, date_range }`.

**Y.2** Job runs in arq; pack is materialized to `/var/lib/vibe-shield/compliance/evidence-packs/<pack_id>/` then zipped.

**Y.3** Pack contents:

```
evidence-pack-<firm>-<date>.zip
├── manifest.json
│   ├── image_sha, image_version
│   ├── shield_version, model_registry
│   ├── zdr_enabled, zdr_verified_at
│   ├── pack_generated_at, generated_by
│   └── checksum (sha-256 over every other file)
├── wisp/
│   ├── wisp.pdf                (rendered from the approved WISP)
│   └── wisp.md                 (source markdown for diffing)
├── vendors/
│   ├── vendor_inventory.csv
│   ├── agreements_summary.csv
│   └── attachments/            (uploaded DPAs, BAAs, SOC2 PDFs)
├── audit/
│   ├── audit_events.csv        (date-ranged, bbox-hashes only)
│   ├── validation_tests.csv    (last 90 days of validation pass/fail)
│   └── egress_calls.csv        (every Anthropic call: request_id, model, prompt SHA, token usage)
├── scans/
│   ├── scan_summary.csv
│   └── high_severity_findings.csv
├── redact/
│   ├── monthly_volume.csv
│   └── fail_closed_events.csv
└── README.md                   (human-readable index for a non-technical reviewer)
```

**Y.4** PDF rendering: WeasyPrint or `wkhtmltopdf` (installed in the image) renders markdown → PDF with the Vibe Shield letterhead and firm-name on every page footer.

**Y.5** Manifest checksum: post-generation, every file's SHA-256 is computed and written into `manifest.json`; the manifest itself is then signed with an HMAC using a key derived from the firm's master appliance secret. A verifier script (`scripts/verify_evidence_pack.py`) lives in the image and can be run by an auditor to confirm the pack hasn't been tampered with.

**Y.6** Retention: generated packs are kept on the appliance for 90 days then auto-purged. The firm can re-generate from the same inputs and get a byte-identical pack (deterministic generation).

**Y.7** Download UI: a "Compliance → Evidence Packs" page lists past packs, with download links and a prominent "Generate new pack" button.

**Y.8** Audit events `evidence_pack.generated`, `evidence_pack.downloaded`.

**Y.9** Permissions: `requires('compliance','admin')` to generate or download.

**Y.10** Tests: a generated pack is byte-identical on regeneration with identical inputs; verifier passes; checksum mismatch is detected.

## 13. Phase Z — Breach notification matrix

**Z.1** `breach_jurisdictions` table seeded with the 50 states + DC + PR. Columns: `code`, `name`, `statute_short_name`, `notification_window_days`, `attorney_general_threshold_residents`, `consumer_reporting_agency_threshold`, `requires_law_enforcement_delay`, `last_updated`. Maintained as a JSON file shipped with the image; loaded via migration.

**Z.2** `firm_states_in_practice`: which states the firm operates in or holds licenses in (org_admin sets this).

**Z.3** When a breach is logged (via `vendor_incidents.our_data_affected=true` OR via a manual `breaches` row), Shield auto-generates a per-jurisdiction action plan: deadlines, who to notify, sample notification copy.

**Z.4** Section 13 of the WISP is auto-rendered from this matrix.

**Z.5** Annual update task: a cron checks an upstream JSON manifest (hosted by Kisaes) once a quarter and flags if the breach laws have changed; firm reviews and accepts.

**Z.6** Permissions: `requires('compliance','admin')`.

**Z.7** Sample notification templates (state AG, affected individuals, CRAs) shipped as markdown — not legal advice, but actual statutory citations and drafting starting points.

**Z.8** "Counsel review required" disclaimer on every breach view: this is a workflow tool, not a legal opinion.

**Z.9** Tests: a 6,000-resident breach in CA + NY + MA produces three distinct deadline rows with correct windows.

## 14. Phase AA — Compliance SPA hub

**AA.1** Route `/compliance` is the hub: tile dashboard with Vendors (count, soonest renewal), WISP (status, last approved), Evidence Packs (last generated, can regenerate), Breaches (open count).

**AA.2** Subroutes `/compliance/vendors`, `/compliance/wisp`, `/compliance/evidence-packs`, `/compliance/breaches`.

**AA.3** Vendor list: searchable table with criticality, last assessment, renewal countdown.

**AA.4** Vendor detail: tabs for Agreements, Assessments, Incidents.

**AA.5** WISP editor: two-pane layout — section list on the left, markdown editor on the right with the "Suggested content" panel below, a "Save draft" / "Submit for approval" footer.

**AA.6** WISP version timeline.

**AA.7** Evidence pack generator: a wizard that surfaces toggles (include scans, include redact audit, date range), then runs the job with SSE progress, then offers the download.

**AA.8** Breach incident form: severity, date, summary, "our data affected" toggle → on yes, auto-shows the per-state deadline grid.

**AA.9** Compliance health badge in the top nav: green/amber/red based on (a) any expired agreement, (b) any unapproved WISP, (c) any open high-severity breach.

**AA.10** Print stylesheet for the WISP editor so it can be printed directly from the browser as a backup.

**AA.11** Permissions guards everywhere; visible-vs-disabled controls based on RBAC.

**AA.12** Tests (Playwright): create a vendor, attach a DPA, complete an assessment, edit and approve a WISP, generate an evidence pack, verify the download manifest.

---

## 15. Phase AB — Internal service API (MyBooks etc.)

**Goal:** Let MyBooks (and later Trial Balance, Tax Research Chat, etc.) hand documents to Shield over the local Docker network and get back a redacted artifact + structured extraction, without ever holding an Anthropic API key.

**AB.1** Route group `/api/internal/*` (only reachable from inside the docker network or via tailscale; reject any request with a public-internet `X-Forwarded-For` unless `VIBE_SHIELD_INTERNAL_ALLOW_PUBLIC=true`).

**AB.2** Auth via `X-Shield-Service-Key` header. Service keys are issued via `POST /api/admin/service-keys` (org_admin only), stored hashed, scoped to one or more services (`mybooks`, `trial-balance`).

**AB.3** Endpoints:

- `POST /api/internal/redact/sync` — multipart upload of the source file, returns the full Redact result (≤3 pages or under the sync threshold).
- `POST /api/internal/redact/async` — multipart upload, returns `{ job_id }`.
- `GET /api/internal/redact/jobs/<id>` — poll status.
- `GET /api/internal/redact/jobs/<id>/artifacts/<kind>` — fetch redacted PDF, extracted JSON, etc.
- `POST /api/internal/scan/text` — body `{ text, entities? }` → returns Presidio results synchronously. No Claude call. Use case: MyBooks runs a quick check on a transaction memo a user typed before persisting it.
- `POST /api/internal/scan/file` — multipart upload, runs a single-file scan synchronously, returns findings.

**AB.4** Service-attribution: every internal call writes `audit_events.actor_type='service'`, `service_name=<from key>`. This is the single most important property of the integration: MyBooks's call shows up in the firm's Shield audit log indistinguishable from a user-initiated redact except for the actor.

**AB.5** Rate limiting per service key (default 600 redacts/hour) — high enough that no MyBooks user notices, low enough that a runaway worker can't burn through Claude budget.

**AB.6** Webhook callbacks: services can register `webhook_url` per key; Shield POSTs `{ job_id, status, result }` on async completion with HMAC signing.

**AB.7** Schema versioning: every response includes `api_version`; clients pin a minor version and Shield supports the prior major for at least 6 months.

**AB.8** Cost attribution: per-service token usage roll-ups so a firm can see "MyBooks used $4.18 of Claude this month, Shield UI used $0.72."

**AB.9** Graceful degradation: if Anthropic is unreachable, async jobs queue and retry; sync calls return `503 Service Unavailable` with `Retry-After`.

**AB.10** Optional pre-extraction redaction-only mode: a service that wants raw redacted text/PDF without the Claude extraction can pass `?extract=false` and get back the redacted artifact only (cheaper, faster, no Anthropic call).

**AB.11** Optional service-supplied prompt template: services can register their own prompt templates (stored in `prompt_templates` table) and reference them by id on internal calls. Shield still owns the model registry and the validation step — the service only controls the extraction prompt.

**AB.12** Health check endpoint `/api/internal/health` returns `{ shield_version, zdr_enabled, anthropic_reachable, queue_depth }`. Used by MyBooks to surface "AI features available" status to its users.

**AB.13** Documented as OpenAPI 3.1; SDK is generated from the spec (Phase AC).

**AB.14** Tests: service key creation, scope enforcement, rate limit, webhook delivery (with HMAC verification).

## 16. Phase AC — MyBooks integration SDK + migration

**AC.1** Publish `@kisaes/vibe-shield-client` npm package (private GHCR-hosted scope). TypeScript types generated from Shield's OpenAPI spec.

**AC.2** Client API:
```ts
const shield = new VibeShield({
  baseUrl: process.env.VIBE_SHIELD_URL,
  serviceKey: process.env.VIBE_SHIELD_SERVICE_KEY,
});

const result = await shield.redact.sync({
  file: fileStream,
  filename: 'chase_2024_03.pdf',
  extract: true,
  promptId: 'mybooks.bank_statement.v1',
});
// → { jobId, redactedPdf: Stream, extracted: BankStatement, auditId }
```

**AC.3** Retry logic with exponential backoff for 429s and 5xx; idempotency keys generated client-side.

**AC.4** Webhook receiver helper for async jobs.

**AC.5** Stream-friendly types (no buffering the whole PDF into memory).

**AC.6** MyBooks codepath migration: remove all `anthropic` SDK usage from `vibe-mybooks`, route every PDF/image extraction through `@kisaes/vibe-shield-client`. Concretely:

- Replace the existing `services/bank-statement-importer` direct-Anthropic path with a Shield call.
- Replace the receipt OCR call site with `shield.redact.sync({ file, promptId: 'mybooks.receipt.v1' })`.
- Replace the document upload preview with a `shield.scan.file({ file })` call to warn before save.

**AC.7** Document the migration as `docs/migrating-from-anthropic-direct.md` in the MyBooks repo.

**AC.8** Compatibility flag `VIBE_MYBOOKS_USE_SHIELD=true` to gate the switchover; revert flag stays for one release cycle in case of issues.

**AC.9** Tests: integration tests in MyBooks against a real local Shield container in CI.

**AC.10** Onboarding doc for new Vibe apps that want to add Shield: copy-paste of the env vars, the SDK install, the standard prompt templates registry pattern.

## 17. Phase AD — Licensing portal hooks

**AD.1** Shield is licensed under PolyForm Internal Use 1.0.0 + commercial tiers, same as MyBooks.

**AD.2** License tiers:
- **Free** — Shield · Redact only (Module 1), single user, no scheduled scans, no evidence pack export.
- **Practice** — All three modules, up to 5 users, scheduled scans, evidence pack export, supports up to 50 vendors.
- **Firm** — Unlimited users, unlimited vendors, internal service API enabled (other Vibe apps can call Shield), webhook delivery.

**AD.3** License check at startup against the same `kisaes-license-portal` service that MyBooks uses.

**AD.4** Module 2 and Module 3 UI tiles are visible but locked on the Free tier with a "Practice tier required" pill that links to upgrade.

**AD.5** Internal service API (Phase AB) returns 402 if called when the firm's license is below Firm tier.

**AD.6** Grace period: 14 days after license expiration during which features work but a banner warns; after 14 days, Module 2 and 3 lock and Module 1 continues to work (safety floor — we don't strand a firm's redaction pipeline because they forgot to renew).

**AD.7** Tests: license downgrade cycles through grace → locked → unlocked correctly.

**AD.8** License-required features tagged in the OpenAPI spec so the SDK can fail closed with a clean error message.

## 18. Phase AE — Release packaging, upgrade, smoke matrix

**AE.1** Single Docker image `kisaes/vibe-shield:1.0.0`. Compose fragment in the Vibe Appliance compose. Standalone compose for firms that don't run MyBooks.

**AE.2** Migration path from a prior `vibe-ocr` install (since the original addendum used that name): a one-shot migration script reads `/var/lib/vibe-ocr/` and copies into `/var/lib/vibe-shield/redact/jobs/`, renaming the database via alembic. Documented in `docs/upgrade-from-vibe-ocr.md`. Idempotent.

**AE.3** Smoke matrix run in CI on every release: bring up the image, run a redact smoke, a scan smoke, generate a WISP, generate an evidence pack, call the internal API as a fake MyBooks service, verify the audit log captured every action.

**AE.4** Backup/restore: `shield-backup` and `shield-restore` shell scripts in the image; dumps Postgres + tars the data directory + redacts secrets from env into a single encrypted tarball.

**AE.5** Upgrade hooks: alembic migrations for the database; for the data directory, version-tagged migrations in `app/migrations/data/` run on first boot of the new image.

**AE.6** Health dashboard exposed at `/admin/system` for `org_admin`: queue depth, recent egress latency, last validation-fixture pass, license tier, Anthropic reachability, disk usage per module.

**AE.7** Telemetry opt-in (off by default): if the firm opts in, anonymous aggregate metrics ship to Kisaes (counts of redactions, error rates, no PII, no firm identification). Documented purpose: catch regressions across the install base.

**AE.8** Release notes template + changelog format (Keep-a-Changelog).

**AE.9** End-user docs site outline:
- Quick start (5 minutes from install to first redaction)
- Redact module guide
- Scan module guide
- Compliance module guide (WISP, vendors, evidence pack)
- Internal API reference + SDK guide
- Operations (backup, upgrade, troubleshooting)
- Security architecture (the page Kurt's CPA-firm sales prospects will read)

---

## 19. Cross-cutting acceptance criteria for Shield v1 (Modules 1 + cross-cutting)

A reviewer installing Shield on a 4 vCPU / 8 GB box and visiting `https://shield.firm.example/` should be able to:

1. Sign in as bootstrap admin via magic link.
2. Drop a sample 2-page bank statement; watch it complete in under 20s; download MD/JSON/PDF/ZIP.
3. Confirm in admin → audit that every step is logged, including a row for the egress call to Anthropic with `request_id`, model, prompt SHA, and token counts.
4. Generate a Service Key for a fake `mybooks` service, call `/api/internal/redact/sync` from `curl` with the key, see the result, and see the audit event tagged `actor_type=service`, `service_name=mybooks`.
5. Find no plaintext copy of the original source PDF anywhere on disk outside the encrypted `source.<ext>` file.
6. See Module 2 (Scan) and Module 3 (Compliance) nav items present but marked "Coming soon" with a link to docs.
7. Run the smoke matrix from `scripts/smoke.sh` and have it pass green.

## 20. Acceptance criteria for Shield v1.5 (Module 2, Scan)

8. Point Shield at a fixture archive of mixed PDFs/DOCX/XLSX; receive a findings report with ≥95% recall against the known-PII corpus.
9. Bulk-redact 10 flagged files; each produces a normal Redact job linked back to the parent scan.
10. Schedule a daily scan of `/srv/client-files`; confirm it runs and emails on findings.

## 21. Acceptance criteria for Shield v2 (Module 3, Compliance)

11. Add Anthropic to the vendor inventory with a current DPA attachment and a "review due" date 60 days from now.
12. Build a WISP using the section catalog; approve v1; see audit events for every section edit.
13. Generate an evidence pack; verify it with the bundled verifier script; confirm the WISP PDF, audit CSV, vendor list, and Anthropic egress log are inside.
14. Log a fake breach affecting CA + MA residents; see the per-state deadline grid render with correct windows.

## 22. Acceptance criteria for Shield v2.5 (Phases AB–AE)

15. Install MyBooks v(next) alongside Shield; confirm MyBooks no longer has `ANTHROPIC_API_KEY` set and that every MyBooks AI feature routes through Shield's internal API.
16. Take Shield offline (`docker stop vibe-shield`); confirm MyBooks gracefully degrades AI features and surfaces the outage in its UI.
17. Downgrade the license to Free; confirm Module 2 and 3 lock cleanly and Module 1 keeps working.

---

## 23. What was renamed from the prior addendum

| Prior name | New name | Notes |
|---|---|---|
| `vibe-ocr-ui-addendum.md` | `vibe-shield.md` | This file supersedes it |
| Vibe OCR Service | Vibe Shield | Product rename |
| OCR appliance | Shield appliance | Internal terminology |
| `services/vibe-ocr/` | `services/vibe-shield/` | Repo path |
| `kisaes/vibe-ocr:1.0` | `kisaes/vibe-shield:1.0` | Image tag |
| `VIBE_OCR_*` env vars | `VIBE_SHIELD_*` env vars | All env vars |
| `vibe_ocr` database | `vibe_shield` database | DB name |
| `/var/lib/vibe-ocr/` | `/var/lib/vibe-shield/redact/`, `.../scan/`, `.../compliance/` | Storage layout, now multi-module |
| Sidebar "Upload" / "Jobs" / "Users" / "Audit" | "Redact / Scan / Compliance / Admin" structure with sub-items | Information architecture |
| `is_admin` single bit | `is_org_admin` + per-module RBAC | Authorization model |
| Anthropic SDK called directly from pipeline | Anthropic SDK reachable only from `app.egress.claude` | Egress consolidation |
| "WISP Evidence Pack" inside admin | First-class Compliance module with its own UI | Promoted to module |

The user-facing OCR workflow from screens 1–4 of the mockup is unchanged — same upload, same job detail, same downloads, same history. Shield adds sidebar navigation for the additional modules and an Admin section, nothing more is visible at v1.

## 24. Out of scope (deferred beyond v2.5)

- Multi-tenant Shield (one appliance serving multiple firms) — explicitly off the roadmap; one-firm-per-appliance is a security feature, not a limitation.
- OIDC / SAML SSO — magic-link plus per-user passkeys (potentially in v3).
- A "Shield Cloud" hosted offering — if it ever happens, it's a separate codebase.
- AI-assisted WISP drafting via Claude — tempting but adds an Anthropic dependency to the Compliance module; v3 evaluation only after the egress wrapper has 12 months of audit history.
- Localization beyond English.
- Native iOS/Android Shield app — the web UI is mobile-friendly; a native app is a separate addendum if firms ask.

Each deferral is intentional: the v1 → v2.5 scope is already ~370 items and the smaller scope is what gets shipped.
