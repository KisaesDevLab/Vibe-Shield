# Vibe Shield — Addendum: Vibe Transactions Converter Integration

**Parent plan:** `VIBE_SHIELD_BUILD_PLAN.md`
**Target app:** `Vibe Transactions Converter` (bank/credit-card PDF → CSV / OFX / QFX / QBO)
**Slots into parent plan:** Inserts as **Phase 16.5** (between Trial Balance and Image Pipeline) and amends Phase 17 (Image redaction) + Phase 18 (Tax Research / GLM-OCR) to acknowledge the Converter dependency.
**Why an addendum, not a paragraph:** the Converter is structurally different from every other Vibe app. Its **input** is dense PII (bank statements), its **AI processing** must run on redacted data, and its **output file** is *required* to contain the original account numbers — that's the entire point of OFX/QFX/QBO. The re-identification policy is therefore inverted from the other apps, and the design needs explicit attention.

---

## 1. Why Transactions Converter is the highest-PII app in the suite

Every other Vibe app handles PII as a byproduct of its real job. The Converter handles PII as its *entire* job:

| PII present in source | Used by Converter | Must reach Anthropic? | Must reach output file? |
|----------------------|-------------------|----------------------|------------------------|
| Account holder name | yes (statement header parse) | no — tokenize | yes (in OFX/QFX `<USERID>` / metadata) |
| Account number | yes (statement header parse) | **no — tokenize** | **yes** (in OFX `<ACCTID>`, QBO `<BANKACCTFROM>`) |
| Routing number (ABA) | yes (statement header parse) | **no — tokenize** | **yes** (in OFX `<BANKID>`) |
| Card last 4 (CC) | yes | no — tokenize | yes (in OFX `<CCACCTFROM>/<ACCTID>`) |
| Mailing address | no (decorative) | no — tokenize | no |
| Transaction memos (payees, Venmo notes, ATM locations) | yes (categorization hints) | no — tokenize | yes (cleartext memo) |
| Check images (signatures, payee, memo) | sometimes | no — image-mask | no (omitted from output) |
| Partial SSN (some statements) | no | no — tokenize | no (stripped) |

The pattern is uniform: **nothing identifiable goes to Anthropic, but the user's output file keeps the cleartext** because the user already has it (it's their client's statement), and accounting software requires real account numbers to import. Shield's token vault is the round-trip mechanism that makes this possible.

---

## 2. Where the Converter currently calls Claude (assumed)

Based on the Converter's role, Claude is the natural choice for:

1. **Document classification** — "is this a Chase checking statement, Amex card statement, or USAA combined statement?" — needed to pick the right column/row template.
2. **Layout detection** — "where does the transaction table start/end, and what's the column order?" — used when no template exists yet.
3. **Header field extraction** — account holder, account number, statement period, opening/closing balance.
4. **Transaction line extraction** — parsing messy multi-line transactions where date/payee/amount/balance aren't column-aligned.
5. **Memo normalization** — turning `"POS DEB 0314 1623 TST* HOMEBOY INDUSTR LOS ANGELE CA"` into `"Homeboy Industries — Los Angeles, CA — 03/14"`.
6. **Bank-specific quirks** — detecting check images, foreign-currency lines, fee carve-outs, deposit slips.
7. **Confidence scoring** — flagging low-confidence rows for human review.

All seven call paths must go through Shield. None of them require Anthropic to see the real account number, the real holder name, the full card number, or the original memo payee identity.

---

## 3. The inverted re-identification policy

This is the design idea that makes the Converter integration work. Every other Vibe app's policy looks like:

> redact → Claude → re-identify per role (junior staff sees tokens, partner sees cleartext)

The Converter's policy looks like:

> redact → Claude → **always full re-identify into the output file** (regardless of caller role)

The output is a file consumed by accounting software, not a screen viewed by staff. The "viewer" is QuickBooks Online, Lacerte, UltraTax, or Vibe MyBooks itself. So the role-based gating that applies elsewhere doesn't apply here.

This warrants a new built-in Shield policy: **`cpa-converter-output`**:

- All entity types tokenized to Anthropic.
- All entity types re-identified to caller — **but only via a specific, audited endpoint** (`POST /v1/sessions/:id/materialize`).
- Materialization is logged separately with the output filename and SHA-256 hash.
- Materialization is one-shot: after the output file is generated and delivered, the session and its token vault entry can be GC'd within minutes (much shorter than the default 90 days). The cleartext lives in the output file at that point, which the user already has.

---

## 4. Phase 16.5 — Vibe Transactions Converter integration

Insert into parent build plan between Phase 16 and Phase 17.

### 16.5.1 — SDK swap & gateway routing

- [ ] Replace `@anthropic-ai/sdk` imports with `@kisaesdevlab/vibe-shield-client` in all Converter LLM call sites
- [ ] Point the SDK at the appliance-internal gateway URL (`http://vibe-shield-gateway:8080`)
- [ ] Apply `cpa-converter-output` policy by default for this app
- [ ] Feature flag `VIBE_SHIELD_ENABLED=true` (default true on appliance; allow false only in non-production)
- [ ] Fail-closed: if Shield is unavailable, the conversion run fails with a clear error rather than calling Anthropic directly

### 16.5.2 — Session model

- [ ] One Shield session per **conversion job** (a single uploaded PDF or a batch of related PDFs for the same account)
- [ ] Session metadata records: file SHA-256, page count, bank/issuer (detected), account-type hint
- [ ] Session TTL: 24 hours by default (long enough for the user to download the converted file and re-run if needed)
- [ ] Manual session purge endpoint exposed in Converter UI ("delete this conversion's data")

### 16.5.3 — PDF intake path

- [ ] Uploaded PDF is held only in the Converter's working storage (encrypted volume)
- [ ] First step: classify PDF as text-PDF, image-PDF (scanned), or mixed
- [ ] **Text-PDF path:** extract text + per-page coordinates, run Shield text redaction on each page's text before any Claude call
- [ ] **Image-PDF path:** rasterize each page, send through Shield image pipeline (Phase 17) for OCR + masking + tokenization, then proceed with the redacted OCR text
- [ ] **Mixed path:** per-page decision between the two
- [ ] No raw PDF bytes ever sent to Anthropic — only redacted text or already-masked images
- [ ] When Claude needs visual context (rare — e.g., disambiguating a column layout), send only the masked image variant from Shield

### 16.5.4 — Header field extraction (the high-stakes call)

- [ ] Header fields (account holder, account number, routing, statement period) are extracted by Claude **from tokenized text**
- [ ] Claude sees: `"Statement for <PERSON_1>, Account <US_BANK_ACCOUNT_1>, Routing <US_BANK_ROUTING_1>, Period 2026-04-01 to 2026-04-30, Opening $4,201.33, Closing $5,187.42"`
- [ ] Claude returns: structured JSON with the token references — `{"holder": "<PERSON_1>", "account": "<US_BANK_ACCOUNT_1>", "routing": "<US_BANK_ROUTING_1>", "period_start": "2026-04-01", ...}`
- [ ] Converter resolves tokens via Shield's materialize endpoint at output time, not before
- [ ] Acceptance: extraction accuracy on a 50-statement golden set is within 1% of pre-Shield baseline

### 16.5.5 — Transaction line extraction & memo normalization

- [ ] Transaction rows extracted from tokenized text in the same session, so a payee that appears 14 times in a month resolves to one token `<PERSON_n>` or `<BUSINESS_n>` consistently across rows
- [ ] Memo normalization: Claude receives tokenized memos and returns cleaned tokenized memos; Shield re-identifies at materialize time
- [ ] Amounts and dates preserved (never redacted) so categorization signal is intact
- [ ] Multi-line transaction merging happens on the tokenized side
- [ ] Low-confidence rows flagged with a `needs_review` boolean returned by Claude

### 16.5.6 — Output file materialization

- [ ] Output writer calls `POST /v1/sessions/:id/materialize` with the structured JSON containing tokens
- [ ] Shield returns the same structure with tokens replaced by cleartext
- [ ] **Writer formats:**
  - CSV: standard column set, cleartext memos and amounts
  - OFX 2.x: `<BANKID>`, `<ACCTID>`, `<ACCTTYPE>`, `<STMTTRN>` blocks populated with materialized cleartext
  - QFX: OFX with Intuit `<FID>` and `<ORG>` fields
  - QBO (QuickBooks Web Connect): same as QFX plus Intuit-specific headers
- [ ] Output file SHA-256 hashed and logged to Shield audit before download is offered
- [ ] Materialization counts as a sensitive event in the audit log (separate event type)

### 16.5.7 — Check images & embedded statements

- [ ] Many bank statements include thumbnail check images on the back pages
- [ ] These are routed through Shield's image pipeline (Phase 17) for face/signature masking before any Claude visual call
- [ ] By default, check images are **not** included in the output file (CSV/OFX/QFX/QBO formats don't carry them anyway)
- [ ] Optional: a "preserve check images" mode where the redacted version is saved to a sidecar folder; this requires explicit opt-in per conversion

### 16.5.8 — Bank-specific templates & vendor library

- [ ] Converter maintains a library of detected layouts per bank/issuer
- [ ] Template detection runs on tokenized headers + page structure (not cleartext)
- [ ] Detected templates are stored without cleartext (use `<BANK_NAME_n>` resolved from a separate, public-bank-names whitelist that bypasses tokenization — Chase, Wells Fargo, Amex are not PII)
- [ ] Public-bank-name whitelist lives in Shield's policy config and is shared across tenants safely

### 16.5.9 — Audit linkage with Converter

- [ ] Every Converter conversion job writes a record linking: conversion_id ↔ shield_session_id ↔ output_file_sha256
- [ ] Converter audit log mirrors Shield event types (request, materialize, recognizer_miss, session_purge)
- [ ] Single peer-review query can answer: "for client X's April Chase statement, show all Anthropic API calls made and confirm none contained the real account number"

### 16.5.10 — Performance, batching & limits

- [ ] Single statement (≤ 30 pages): end-to-end conversion target P95 < 60 seconds on NucBox M6 (including Shield overhead)
- [ ] Batch upload (e.g., 12 months of statements): processed sequentially per session to preserve token consistency; parallel across sessions
- [ ] Hard cap on PDF size: 50 MB per file in v1 (configurable)
- [ ] Streaming materialize for very long outputs

### 16.5.11 — Test fixtures (synthetic only)

- [ ] Synthetic statement corpus generator: produces fake-but-realistic PDFs for Chase, BofA, Wells, Amex, Capital One, USAA, local credit unions
- [ ] Faker-generated names, addresses, account numbers in non-issued ranges, ABA routing numbers with valid checksums but in test ranges
- [ ] Scanned variants (rasterized + light noise + slight rotation) for image-path testing
- [ ] Edge cases: foreign currency, joint accounts, business accounts with multiple authorized users, statements that include canceled-check thumbnails
- [ ] CI runs a 25-statement set on every PR to catch extraction regressions

### 16.5.12 — Engagement letter & disclosure

- [ ] Add Converter-specific paragraph to the engagement letter template in `compliance/engagement-letter-language.md`:
  > "When converting bank or credit card statements, the Firm uses an AI-assisted document processing service. Account numbers, holder names, addresses, and transaction memos are replaced with opaque placeholders by a local privacy gateway before any AI processing occurs. The AI provider never receives identifiable account or holder information. The final converted file (CSV, OFX, QFX, or QBO) restores the original values from a local key held by the Firm, never the provider."
- [ ] WISP section in `compliance/wisp-section.md` updated to name the Converter as a downstream consumer of Shield, with a one-paragraph description of the inverted re-identification flow

### 16.5.13 — UI: app shell, auth & layout

- [ ] New app at `apps/converter-web` in the Converter repo: React 18 + TypeScript + Vite + shadcn/ui + Tailwind (matches MyBooks/Trial Balance)
- [ ] Auth via firm SSO; share session with MyBooks if both deployed on the same appliance
- [ ] Caddy route `converter.<domain>` (domain mode) / LAN IP (LAN mode) / Tailscale URL (Tailscale mode)
- [ ] App shell: persistent left sidebar (Upload, Jobs, History, Settings, Audit), top bar with org switcher and **Shield status indicator** (green/yellow/red dot showing redaction-engine health + commercial-key verification)
- [ ] Route structure: `/upload`, `/jobs/:id`, `/jobs/:id/review`, `/jobs/:id/download`, `/history`, `/settings`, `/audit`
- [ ] State: TanStack Query for server state, Zustand for transient UI state
- [ ] Dark mode (system default); print-friendly review page
- [ ] Tests: route smoke tests with Vitest; visual regression with Playwright

### 16.5.14 — Upload page (the front door)

- [ ] Large drag-and-drop zone (`react-dropzone`); also "browse files" button
- [ ] Multi-file upload; supports dragging a folder (e.g., 12 monthly statements)
- [ ] Per-file row appears as it's processed client-side:
  - Page-1 thumbnail (rendered locally via `pdf.js`)
  - Detected bank guess (from Converter's classifier, fast first pass)
  - Detected statement period
  - Page count
  - Editable: client/entity binding, statement type, period override
- [ ] **Client/entity binding** dropdown searches against the firm's client list (pulled from MyBooks if integrated; standalone client list otherwise)
- [ ] Privacy banner above the dropzone: *"Files are processed locally on this appliance. Account numbers and names are replaced with placeholders before any AI step. [Learn how →]"* — link opens a side drawer with the full Shield workflow diagram
- [ ] "Start conversion" button → POSTs to converter API, returns batch_id, redirects to job-list view filtered to that batch
- [ ] Validation: max file size (50 MB), max files per batch (50), PDF-only
- [ ] Error toast for rejected files with specific reason
- [ ] Optimistic UI: files appear in "queued" state immediately

### 16.5.15 — Job detail page (live progress + transparency)

- [ ] Live updates via Server-Sent Events from the Converter API (no WebSocket complexity needed)
- [ ] **Pipeline visualization** as a horizontal stepper: Uploaded → Classified → Headers Extracted → Transactions Parsed → Memos Normalized → Ready for Review. Current step pulsing, completed steps checkmarked.
- [ ] Per-page progress bar for long statements (e.g., "Parsing transactions: page 7 of 24")
- [ ] **"Privacy details" expandable panel** (collapsed by default, prominent for the curious):
  - Shield session ID (with copy-to-clipboard for audit)
  - Entities tokenized count, broken down by type (8 names, 47 account references, 312 transaction memos)
  - Recognizer misses caught by backstop (if any) — shown in yellow with link to recognizer-tuning page
  - ZDR enabled: yes/no
  - Model used (e.g., Claude Sonnet 4.6)
- [ ] Error states: per-step retry where safe; full-job retry; "report to support" button that bundles redacted logs (no cleartext leaves the appliance)
- [ ] Cancel button: hard-stops the job and purges the Shield session immediately
- [ ] "Open review →" CTA appears when status flips to ready

### 16.5.16 — Transaction review grid

The most important screen. CPAs will spend more time here than anywhere else in the app.

- [ ] TanStack Table with virtualized rows (handles 1000+ transactions smoothly)
- [ ] Columns: Date | Description (raw) | Description (normalized) | Amount | Running Balance | Category guess | Confidence | Flag
- [ ] **Confidence indicator** as colored chip: green (≥0.9), yellow (0.7–0.9), red (<0.7)
- [ ] Low-confidence rows pre-filtered to top by default; toggle to "Show all rows"
- [ ] Click row → right-side drawer opens showing the source PDF page with a bounding-box highlight on the matched line; user can verify visually
- [ ] Inline editing for Date, Description, Amount; balance auto-recalculates
- [ ] Bulk-select with checkboxes; bulk actions: recategorize, mark reviewed, delete row (rare — corrupted parse)
- [ ] "Review only flagged" mode that hides confident rows
- [ ] Filter bar: search across descriptions, date range, amount range, category
- [ ] Keyboard shortcuts (visible in `?` overlay):
  - `j` / `k` — next / previous row
  - `e` — edit current row
  - `f` — toggle flag
  - `⌘+S` — save changes
  - `⌘+↵` — approve and proceed to download
- [ ] Unsaved-changes warning on nav-away
- [ ] **Reconciliation footer:** opening balance + sum of transactions = closing balance. Shows green ✓ or red ✗ with the delta — bookkeepers catch transcription errors instantly here.
- [ ] Tests: golden-file tests against synthetic statements ensuring grid renders the right rows

### 16.5.17 — Download / format picker

- [ ] Step appears after review approval; full-page or large modal
- [ ] Format selection as four cards with one-line descriptions:
  - **CSV** — universal; opens in Excel, Sheets, anywhere
  - **OFX** — Open Financial Exchange; for most accounting software imports
  - **QFX** — Quicken's OFX variant; for Quicken Personal/Business
  - **QBO** — QuickBooks Web Connect; for QuickBooks Desktop/Online direct import
- [ ] Multi-format checkboxes — user can download all four at once if they want
- [ ] Live preview pane showing first 10 rows in the selected format (rendered server-side from tokenized data so the preview itself doesn't materialize PII early)
- [ ] Filename pattern field with token autocomplete: `{client}`, `{bank}`, `{period}`, `{period_start}`, `{account_last4}`, `{date}`. Default: `{client}-{bank}-{period}.{ext}`
- [ ] **Materialize & download** button — this is the action that triggers Shield's materialize endpoint, writes the cleartext file, and serves it as a download. Button label reflects gravity: *"Generate file with original account info"*
- [ ] One-time pre-materialize confirmation modal: *"This will write the original account number(s), holder name(s), and transaction memos to the output file. The download is logged in your compliance audit trail."* — proceed / cancel
- [ ] Post-download success state: download links remain available for the session TTL (default 24h); re-download triggers a new materialize event (re-audited)
- [ ] One-click re-export in an alternate format from the same session

### 16.5.18 — History view

- [ ] Paginated table of past conversions
- [ ] Columns: Date | Client | Bank | Statement Period | Formats Downloaded | Status | Actions
- [ ] Status badges: Completed, Failed, Soft-Deleted, Purged
- [ ] Filter sidebar: client picker, date-range picker, bank multi-select, status multi-select
- [ ] Quick-search bar in the header
- [ ] Row actions menu:
  - Re-download (only if session is alive or output file retained)
  - View audit trail (deep-link to /audit filtered to this conversion)
  - Soft-delete (hides from default view; 30-day undo banner)
  - **Permanent purge** (typed-confirmation: type the client name to confirm; immediately destroys output file, audit retains hash only)
- [ ] Bulk export to ZIP for archival/year-end handoff
- [ ] Empty state for first-time users with link to a tutorial conversion

### 16.5.19 — Settings & onboarding

- [ ] **Defaults panel:** default output format, filename pattern, post-materialize session purge timing (within policy bounds: 5min / 1hr / 24hr)
- [ ] **Bank template library:** read-only view of detected layouts with per-template confidence stats, last-seen date, sample-count. Useful for partners auditing accuracy.
- [ ] **Client list integration:** toggle "Pull clients from MyBooks" (if MyBooks deployed on same appliance) vs. "Manage clients here"
- [ ] **Anthropic key panel:** masked key display, "Test connection" button (probes for commercial-key status; refuses to save consumer keys), Trust Center link, "Last reviewed" date with annual-review reminder
- [ ] **Onboarding flow** triggered on first sign-in:
  1. Welcome screen with one-paragraph privacy model
  2. Anthropic key entry + commercial verification
  3. Engagement letter template download with a copy that pre-fills firm name
  4. Tutorial: drag the bundled synthetic Chase statement into the dropzone, walk through review and download
  5. "You're ready" → home screen
- [ ] Help / docs panel always reachable from the top bar; embeds the compliance memo's plain-English summary

### 16.5.20 — Accessibility, responsive design & polish

- [ ] WCAG 2.1 AA target; axe-core checks in CI
- [ ] Keyboard navigation throughout, with visible focus rings on shadcn defaults
- [ ] Screen-reader labels on all action buttons and status indicators
- [ ] Color is never the only signal (confidence chips have icons too: ✓ / ⚠ / ✗)
- [ ] Mobile breakpoints:
  - Phone: upload + job status view only; review grid is intentionally desktop/tablet-only with a friendly redirect message
  - Tablet (iPad landscape): full app usable including review grid
- [ ] Loading skeletons for every data-driven panel
- [ ] Optimistic updates on edits with rollback on server error
- [ ] Empty states with onboarding hints (never blank screens)
- [ ] Error boundary at the route level with "Report to support" button that bundles redacted diagnostic info
- [ ] Print-friendly review page (for clients who want a paper trail)
- [ ] E2E tests with Playwright running against the synthetic corpus on every PR

### 16.5.21 — Acceptance criteria (Converter-specific, additive to parent §10)

12. Sampled conversion jobs show: zero cleartext account numbers, routing numbers, or holder names in any payload sent to Anthropic.
13. Sampled output files (CSV/OFX/QFX/QBO) show correctly materialized account numbers and holder names matching the original PDF.
14. Materialize events are logged with output file hashes and are traceable end-to-end from upload to download.
15. Image-path conversions (scanned statements) show masked check thumbnails and faces in any Claude visual call.
16. A non-technical staff member (junior bookkeeper, no app training) can convert a single statement end-to-end in under 5 minutes on first try.
17. The privacy explainer is reachable in one click from any page that touches client data.
18. Every download action creates a visible, dated entry in the user-accessible audit trail within 1 second.
19. The reconciliation footer on the review grid surfaces opening + transactions ≠ closing within 100 ms of any edit.
20. Keyboard-only operators can complete the full upload → review → download flow without a mouse.

---

## 5. Amendments to existing phases

### Phase 17 (Image redaction) — add bullet

- [ ] Image pipeline supports the Converter's per-page rasterization workflow: the Converter can submit a page image and receive `{redacted_image, ocr_text_tokenized, token_map_session_id, bbox_audit}` in a single round trip. Same session_id can be reused across all pages of a single statement.

### Phase 18 (Tax Research / GLM-OCR) — add bullet

- [ ] GLM-OCR is the preferred OCR backend for the Converter's image path. Tesseract is the fallback if GLM-OCR is not deployed on the appliance.

### §5 Integration touchpoints — replace row

Replace the placeholder row that doesn't currently list Transactions Converter with:

| **Vibe Transactions Converter** | Document classification, layout detection, header extraction, transaction parsing, memo normalization | Swap SDK; apply `cpa-converter-output` policy; one Shield session per conversion job; image path through Phase 17; materialize endpoint called only at output-file write |

---

## 6. New risks introduced by this integration

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Materialize endpoint becomes a bypass of redaction guarantees | Low | Critical | Materialize requires session ownership + only writes to disk, never to network; rate limited; audited as a separate event type; only `cpa-converter-output` policy enables it |
| OFX/QFX/QBO output file is exfiltrated and contains full account data | Medium | High | Same as today's bank-statement-PDF risk; no worse. Output files are not Shield's responsibility once delivered. WISP covers post-delivery handling. |
| Token consistency breaks across pages of a long statement → same payee gets two tokens → categorization fragmentation | Medium | Medium | Single session per conversion job; deterministic tokenization within session (Phase 6) |
| Scanned statement OCR misses an account number printed faintly → Claude sees real digits | Low | High | Regex backstop layer runs on OCR'd text even after Presidio (Phase 4); recognizer-miss event auto-blocks downstream Claude call when severity = critical |
| Converter caches Claude responses with tokens, then materializes against a purged session → broken output | Low | Medium | Materialize-before-session-GC contract; Converter never persists tokenized responses past materialize step |

---

## 7. Effort estimate

- **Shield-side work:** ~2 days. Add `cpa-converter-output` policy, `/sessions/:id/materialize` endpoint, materialize audit event type, public-bank-name whitelist. All hooks into existing Phase 5/6/9/10/11 work.
- **Converter backend work:** ~3–5 days depending on current LLM call site count. Mostly SDK swap, session lifecycle wiring, materialize call at output-writer boundary.
- **Converter UI work:** ~8–12 days for a single frontend engineer (or Claude Code agent under a competent reviewer). Breakdown: app shell + auth (1d), upload (1d), job detail with SSE (1d), review grid (3d — this is the big one), download (1d), history (1d), settings + onboarding (1d), polish + accessibility + E2E tests (1–2d).
- **Test fixtures:** ~2 days for the synthetic statement corpus generator.
- **Compliance docs:** ~half a day.

Total: roughly **three to four weeks** of focused work, slotted after Phase 16 of the parent plan. The UI is the long pole; everything else parallelizes against it.

---

## 8. Open questions before kickoff

1. **Is the Converter currently calling Claude directly, or already using a thin abstraction?** If the latter, the SDK swap is even smaller.
2. **Does the Converter persist intermediate JSON between Claude call and output write?** If yes, that JSON must store tokens — never cleartext.
3. **Should `cpa-converter-output` policy auto-purge the token vault entry after materialize, or wait the session TTL?** Default proposed: auto-purge within 5 minutes of successful materialize. Safer, and the cleartext now lives in the output file the user just downloaded anyway.
4. **Multi-file batch jobs** (e.g., 12 monthly statements uploaded together): one session shared across all 12 files, or one session per file? Proposed: one session per file, with a `batch_id` linking them for audit only. Keeps blast radius small and matches the natural "one statement = one OFX file" output cardinality.
5. **Is the Converter UI standalone, or does it embed into MyBooks as a tab?** Proposed: standalone at `converter.<domain>` with deep links from MyBooks (e.g., from a client's bank-feed-import page). Standalone matches the Vibe Appliance per-app pattern and avoids coupling release cycles.
6. **Does the existing Converter build plan already include a UI layer?** This addendum was written as if the canonical UI lives here. If a different UI exists, treat 16.5.13–16.5.20 as the spec to align against; resolve conflicts in favor of the privacy/audit-surfacing patterns described here.
7. **Client list source of truth.** If a firm runs both MyBooks and the Converter on the same appliance, clients should sync one-way from MyBooks. If standalone, the Converter maintains its own client list. The Settings panel exposes the toggle; the default depends on what else is deployed.
