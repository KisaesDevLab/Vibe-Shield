# Vibe Trial Balance → Vibe Shield integration plan

**Target app:** [trial-balance-app](https://github.com/KisaesDevLab/trial-balance-app) — Vibe Trial Balance
**Repo path (local):** `C:\Users\kwkcp\Projects\trial-balance-app`
**Shield version this plan targets:** `v1.1.4+`
**Plan version:** 1.0 (initial)

---

## § 1. Mission

Vibe Trial Balance routes every Anthropic call through Vibe Shield so client EINs, account numbers, journal-entry descriptions, bank-statement extractions, and the SSE-streamed support chat all transit a redaction boundary before reaching Claude. Today the app already does *some* hand-rolled masking (it strips bank account numbers to last-4 in `bankStatementPdfImport.ts` before sending to vision). Shield replaces that ad-hoc layer with the canonical redaction pipeline and adds the dozens of recognizers (SSN, EIN, ROUTING, EMAIL, PHONE, PERSON, etc.) the manual code doesn't cover.

This integration is the second-lowest risk of the four: TB has the most layered AI surface (7 features) but a clean `aiClient.ts` chokepoint with provider abstraction (`ClaudeProvider`, `OllamaProvider`, `OpenAIProvider`). The Anthropic provider is the only one this plan touches; the local Ollama path is left alone.

Default policy: `cpa-bookkeeping-balanced` (same as MyBooks — no operator materialize).

---

## § 2. PII surface inventory

### 2.1 Client + engagement data

Source: `clients` table (migration `20260316000008_add_tax_id_to_clients.js`).

| Field | Reaches Anthropic today? | Post-Shield |
|---|---|---|
| `clients.name` | Yes (in diagnostics, tax-code suggestions, chat) | Tokenized to `<BUSINESS_NAME_n>` or `<PERSON_n>` |
| `clients.tax_id` | Yes | `<US_EIN_n>` |
| `clients.entity_type` | Yes (e.g. "1065", "1120-S") | Whitelisted as tax-form (already in Shield's `protected_ranges`) |
| `clients.tax_year_end` (MMDD) | Yes | Whitelisted as calendar date |

### 2.2 Accounting data

| Source table / field | PII risk |
|---|---|
| `trial_balance.*` (account, debit, credit) | Low — numeric. Risk is in adjacent narrative columns. |
| `journal_entries.description` | High — free-text. May reference client names, vendor names, contract numbers. |
| `bank_transactions.description` | Highest — payee/memo text, the canonical AI categorization input. Often contains contact names + invoice numbers. |
| `bank_transactions.check_number` | Low (numeric) but Shield's deconflict layer might wrong-tag as PHONE; existing v1.1 deconflict handles this. |
| `chart_of_accounts.workpaper_ref` | Low — typically alphanumeric WP IDs like "A-1", "B-10". |
| `chart_of_accounts.preparer_notes`, `reviewer_notes` | High — free-text preparer comments; may include client SSN/EIN in informal asides. |

### 2.3 Imported documents

| Document type | Path | PII payload |
|---|---|---|
| Trial Balance PDF | `POST /api/v1/periods/{id}/pdf-import` (`pdfImport.ts`) | Client name, accounts, full TB |
| Bank Statement PDF | `POST /api/v1/clients/{id}/bank-statement-import` (`bankStatementPdfImport.ts`) | Account holder, full account number (currently last-4-masked manually), bank name, every txn |
| GL/TB CSV | `POST /api/v1/periods/{id}/csv-import` (`csvImport.ts`) | Account names + amounts; sometimes contact references in memo columns |
| Excel | same CSV route after ExcelJS conversion | same as CSV |
| Client documents | `POST /api/v1/clients/{id}/documents` | Anything — workpapers, contracts, statements |

**Existing manual mask** (`bankStatementPdfImport.ts:58–69`): regex replaces 6+ digit runs with last-4-preserved form. Shield's `protected_ranges` + `US_BANK_ACCOUNT` recognizer covers this case + dozens more (SSN, EIN, routing, etc.) the manual code doesn't.

### 2.4 Chat / support input

| Source | PII payload |
|---|---|
| `POST /api/v1/support/chat` (SSE) | Free-form user prompt + cached knowledge base context. The knowledge base itself is firm-internal docs (not client PII); the prompt is where PII enters. |

### 2.5 What does NOT need Shield

- Login flow, JWT, 2FA — no Anthropic involvement.
- MCP agent integration (Claude Desktop) — that's a separate, operator-controlled channel; not part of TB's Anthropic-via-app surface.
- node-cron scheduled backup — no AI.

---

## § 3. Current Anthropic touchpoints

### 3.1 The provider chokepoint

| File | Lines | What |
|---|---|---|
| `server/src/lib/aiClient.ts` | 5 | `import Anthropic from '@anthropic-ai/sdk';` (v0.78.0) |
| same | 117 | `provider = new ClaudeProvider(new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 }))` — primary text path |
| same | 202 | `new Anthropic(...)` again — vision-capable model override when configured separately |
| same | 113–114 | API key fetched from `settings.claude_api_key` (encrypted) with fallback to `process.env.ANTHROPIC_API_KEY` |
| same | 16, 17 | Model defaults: fast = `claude-haiku-4-5-20251001`; primary = `claude-sonnet-4-6` |
| `server/src/lib/llmProvider.ts` | 87–92 | `ClaudeProvider.complete()` → `client.messages.create()` |
| same | 103–110 | `ClaudeProvider.stream()` → `client.messages.stream()` (for support chat SSE) |
| same | 144–150, 269–274 | Vision content blocks: base64 image parts in `messages.create()` |

### 3.2 Call sites (the 7 AI features)

| Feature | Route | Provider method | Stream? |
|---|---|---|---|
| AI Diagnostics | `POST /api/v1/periods/{id}/diagnostics` | `complete()` | No |
| Bank Classification | bank-transactions classification | `complete()` | No |
| Tax Code Assignment | `POST /api/v1/periods/{id}/tax-code-assignments` | `complete()` | No |
| **TB PDF Import (vision)** | `POST /api/v1/periods/{id}/pdf-import` | `complete()` (with image blocks) | No |
| **Bank Statement Vision OCR** | `POST /api/v1/clients/{id}/bank-statement-import` | `complete()` (with image + manual-masked text) | No |
| **Support Chat (SSE)** | `POST /api/v1/support/chat` | `stream()` | **Yes — SSE** |
| CSV/Excel column mapping | inside `csvImport.ts` | `complete()` | No |

The single SSE path is `/api/v1/support/chat`. All others are request/response.

### 3.3 Base URL

**No `ANTHROPIC_BASE_URL` env var or override path today.** Adding one is part of Phase 1.

---

## § 4. Architecture decisions

### 4.1 Replace at the SDK constructor, keep the provider abstraction

`ClaudeProvider` wraps the SDK; `OllamaProvider` and `OpenAIProvider` use their own SDKs. The Shield integration replaces ONLY the Anthropic constructor at `aiClient.ts:117` and `aiClient.ts:202`. The provider abstraction is preserved untouched. Other providers (Ollama for local LLM) are out of scope — they don't reach Anthropic.

### 4.2 Remove the manual account-number masking

`bankStatementPdfImport.ts:58–69` regex-masks 6+ digit runs to last-4 form before sending to Claude. After Shield integration:

- This manual code becomes redundant — Shield's `US_BANK_ACCOUNT` recognizer + `protected_ranges` cover it correctly.
- Keep the manual mask as a transient belt-and-suspenders layer during Phase T1–T2 rollout (so we don't regress while migrating).
- **Remove the manual mask in Phase T5** with the audit step that confirms Shield's coverage.

### 4.3 The SSE support chat needs Shield's streaming path

Shield's gateway has SSE buffering with token-boundary preservation (per `apps/gateway/src/proxy/streaming.ts`). When TB's support chat uses Shield's streaming variant:

- Token re-identification happens per-delta (preserves the streaming feel).
- Partial tokens straddling chunk boundaries are buffered until the closing `>` arrives.
- Shield emits `vs-session-id` header so the chat can reuse the session across reconnects.

TB's existing client-side SSE parser (`useChatStream.ts`-style) works unchanged because Shield's SSE shape matches Anthropic's.

### 4.4 Vision image flow: route through `/redact-image`

Same as MyBooks (§4.2 of `vibe-mybooks.md`). TB has 2 vision callers (TB PDF Import, Bank Statement Vision OCR) — both get the `/redact-image` pre-step.

### 4.5 Settings storage stays put

`settings.claude_api_key` (encrypted) repurposed to hold the `vs_live_*` Shield key. No schema change needed; the value's shape just changes. Migration: a one-time admin action via the Settings UI to swap the key.

### 4.6 Policy choice

- Default: `cpa-bookkeeping-balanced` — re-id on response; no materialize; tax-form whitelisting active.
- Optional firm-strict mode: `cpa-bookkeeping-strict` — ZDR required; backstops fail-closed on low confidence.
- TB does NOT need `cpa-converter-output` — the firm reviews AI suggestions in the UI; they don't export to a third-party format with embedded cleartext.

### 4.7 MCP path is out of scope

The MCP agent integration (`mcp/server.ts`) is for Claude Desktop, which is the operator's own Claude UI. That is NOT a Vibe-shielded path — the operator has direct Claude access by design. This plan does not touch MCP.

---

## § 5. Phased implementation

### Phase T0 — Shield reachable from TB

- [ ] Vibe Appliance has `vibe-shield` enabled.
- [ ] TB operator can `curl http://vibe-shield-gateway:8080/health` from a TB api container.
- [ ] Admin issues a tenant API key for `tenantId: trial-balance-prod`.

**Acceptance:** Same as MyBooks M0 — `curl -H "Authorization: Bearer vs_live_..."` to Shield returns a Shield envelope.

### Phase T1 — SDK swap (Anthropic provider only)

- [ ] Add `@kisaesdevlab/vibe-shield-client` to `server/package.json`.
- [ ] Replace `import Anthropic` at `aiClient.ts:5` with the Shield client.
- [ ] Replace `new Anthropic({...})` at `aiClient.ts:117` AND `aiClient.ts:202`.
- [ ] Add `ANTHROPIC_BASE_URL` env var (zod-validated). Default for appliance: `http://vibe-shield-gateway:8080`.
- [ ] Update `.appliance/manifest.json` env block as in MyBooks M1.
- [ ] Existing test suite passes.

**Acceptance:** A diagnostics call against a running Shield instance succeeds end-to-end and the Shield audit log shows the request body contained tokens, not cleartext.

### Phase T2 — Policy + session

- [ ] In `ClaudeProvider`, attach `policy_name` + `session_id` to every `messages.create` and `messages.stream` call.
- [ ] Session ID strategy:
  - **Diagnostics, tax-code, classification, PDF import, statement import**: one session per (clientId, periodId). All AI for that engagement period shares tokens.
  - **Support chat**: one session per conversation_id. Chat history within the conversation reuses tokens for stable re-id.
- [ ] When a period is finalized + locked, call `Shield POST /v1/sessions/<id>/purge`.
- [ ] When a chat conversation is closed (or after 60-min idle), same purge.

**Acceptance:** Send the same client name twice in one period; verify identical `<BUSINESS_NAME_n>` or `<PERSON_n>` token (Shield audit). After period close, materialize on those tokens returns "session expired".

### Phase T3 — Vision pipeline through `/redact-image`

- [ ] In `pdfImport.ts` (TB PDF) and `bankStatementPdfImport.ts`:
  1. Rasterize PDF pages to images (existing code).
  2. POST each page image to Shield's `/redact-image`.
  3. Receive masked image + token_map + OCR text.
  4. Send the masked image to Claude via the vision provider; receive the response.
  5. Shield's re-identifier returns cleartext in the response.

- [ ] **Keep** the manual `maskAccountNumbers()` from `bankStatementPdfImport.ts:58–69` for now. Belt-and-suspenders during T1–T2 (removed in T5).

**Acceptance:** Bank statement PDF with `Account # 234567890123` → Shield audit shows the LLM saw `<US_BANK_ACCOUNT_1>` only; final UI shows the original digit string in the parsed transactions.

### Phase T4 — SSE support-chat path

- [ ] `ClaudeProvider.stream()` (`llmProvider.ts:103–110`) calls Shield with `stream: true`. Shield's gateway streams back SSE with re-identified text.
- [ ] Pin the regression: a streamed assistant message containing `<PERSON_3>` mid-chunk gets the correct cleartext name in the user's UI.
- [ ] Heartbeat (existing 15s keepalive in TB's support chat) continues to work unchanged.
- [ ] If Shield drops mid-stream, TB surfaces the same "stream interrupted; please retry" UX as today.

**Acceptance:** A support-chat conversation about a real client (name + EIN in the prompt) shows: Shield audit captures tokens only; the streamed reply to the user contains the cleartext client name + EIN; no cleartext appears in TB's chat-message persistence (`chat_messages.content` column).

### Phase T5 — Remove the manual account-number masking + cleartext-leak audit

- [ ] Delete the `maskAccountNumbers()` helper from `bankStatementPdfImport.ts`. Shield's recognizer suite + `protected_ranges` covers it.
- [ ] Add 5+ TB-specific synthetic fixtures to Shield's `qa/corpus/synthetic/`:
  - Trial balance PDFs (multiple firm formats: Caseware export, ProSystem fx export, CCH ProSeries export).
  - Bank statement PDFs in firm-statement-paper formats (not just the bank-issued ones MyBooks covers).
  - GL CSV exports with PII in description columns.
- [ ] Audit: grep TB container logs + `chat_messages.content` for cleartext PII strings used in tests.

**Acceptance:** `grep -rE 'Maria Reyes|234-56-7890|012345678|hector\.diaz' /var/log/tb/` = 0; `psql -c "SELECT count(*) FROM chat_messages WHERE content LIKE '%234-56-7890%'"` = 0.

### Phase T6 — Fail-closed contract

Same shape as MyBooks M4. TB-specific items:

- [ ] When Shield is down, the support chat shows: "Chat is temporarily unavailable. Please retry in 30 seconds."
- [ ] When Shield returns 429 with `Retry-After: 30`, TB honors it both in the diagnostics dashboard call and the support chat.
- [ ] Spend-cap (403) maps to a banner on the TB Settings → AI page: "Monthly AI spend limit reached. Contact your firm administrator."

**Acceptance:** With Shield stopped, every AI button shows the expected error; no 500s; no degraded fallback to direct Anthropic.

---

## § 6. Hard rules for this integration

1. **`@anthropic-ai/sdk` import only in `aiClient.ts`.** Any other `import Anthropic from '@anthropic-ai/sdk'` in TB's source is a hard-rule violation. Enforce via a TB-side lint rule mirroring Shield's `scripts/check-no-anthropic-direct.sh`.

2. **Ollama provider is NOT a Shield bypass.** If a firm has chosen the Anthropic provider (the most common case), the firm cannot then secretly use the Ollama path for "the prompts they don't want Shield to see." Provider choice is operator-explicit; runtime fallback to a different provider is forbidden.

3. **MCP agent surface is OUT of scope.** Operators using Claude Desktop via MCP have direct Claude access by design. TB does not silently route MCP traffic through Shield — that would change the operator's mental model.

4. **The manual account-number mask MUST be removed (Phase T5).** Keeping both Shield + the manual mask permanently is "defense in depth" only on the surface — in practice it makes Shield's recall metrics misleading and creates ambiguity about which layer is authoritative.

5. **Vision PDFs: the masked variant is what Claude sees.** The original PDF stays in TB storage; the per-page masked images are the AI input. Do not retain the unmasked rendered images anywhere on disk.

---

## § 7. Test plan

### 7.1 TB-side integration tests

Add a `TB → Shield → mock Anthropic` integration suite covering:

- **Diagnostics**: send a period with client EIN in JE descriptions; verify Shield audit shows `<US_EIN_n>`, response has cleartext re-id'd.
- **Bank statement PDF**: upload a synthetic Chase statement (use Shield's `qa/corpus/synthetic/statements.py` fixture as inspiration); verify the full account number does NOT reach the Anthropic-mock and DOES appear in the final imported transactions table.
- **Support chat streaming**: SSE call with PERSON + US_EIN in the prompt; verify each delta event sent to the browser is re-identified; verify the persisted chat row contains cleartext (re-id'd) text.
- **Session reuse**: 3 diagnostics calls for the same period; same client name = same token in each.
- **Provider isolation**: configure Ollama provider; verify NO calls go to Shield (the Ollama path is local-only).

### 7.2 Recall/precision regression

Same workflow as MyBooks (§7.1). TB contributes:

- 5+ trial-balance PDF fixtures with the firm-format variations the recon found (Caseware, ProSystem, CCH ProSeries).
- 3+ bank-statement formats not already covered by MyBooks.
- 5+ GL CSV samples with PII embedded in description / memo / payee columns.

Shield's QA harness must continue to pass the 0.90 precision floor on every entity type after these fixtures are added.

### 7.3 Cleartext-leak audit

Grep targets specific to TB:

- `chat_messages.content` (Postgres) — re-identified user-visible text is OK; raw token strings should NOT appear (re-id always happens before persistence).
- `bank_transactions.description` (Postgres) — populated by AI; should contain re-identified cleartext, not raw `<PERSON_n>` markers.
- Container logs for `pino` JSON lines with PII strings.

Expected matches for each: zero raw tokens (`<PERSON_n>`, `<US_EIN_n>` etc.), zero cleartext PII in audit / telemetry tables.

---

## § 8. Rollout

### 8.1 Pre-rollout

- [ ] Phase T0–T6 complete on a feature branch.
- [ ] Integration tests green in CI against stub Shield.
- [ ] Staging Vibe Appliance runs TB-with-Shield for 1 week with synthetic load.

### 8.2 Canary

- [ ] Enable `TB_USE_SHIELD=true` for one firm. Monitor:
  - Shield's `vs_recognizer_misses` table for TB-tenant entries.
  - AI feature acceptance rate (variance suggestions accepted, tax codes accepted, classifications accepted) compared to pre-Shield.
  - Support chat SSE drop rate.
- [ ] Anything significant goes hold + investigate.

### 8.3 GA

- [ ] After 30 days clean canary + zero cleartext-leak findings in production grep, default `TB_USE_SHIELD=true` on the appliance.
- [ ] Update appliance installer to issue the TB tenant key automatically.
- [ ] Deprecate the firm-internal "set claude_api_key directly" UI flow in favor of "Shield issues the key, paste it here." Old flow stays as fallback for 1 release.

### 8.4 Bypass

Same as MyBooks (§8.4). Documented escape hatch, audit-logged, counts as an incident.

---

## § 9. Open questions

| # | Question | Owner | Resolution before |
|---|---|---|---|
| 1 | The vision-capable model is sometimes configured separately (`aiClient.ts:202`). Does Shield see both providers as one tenant key, or do we issue two? | TB lead + Shield owner | Phase T1 |
| 2 | Support chat's knowledge-base context (cached firm-internal docs) is injected as system prompt. Does THAT need redaction, or is the system-prompt content trusted because it's operator-curated? | TB PM | Phase T4 |
| 3 | The `forced password reset` flow on first admin login: should the temporary admin/admin period have Shield in front of any AI feature, or is AI gated until the password change anyway? | TB lead | Phase T0 |
| 4 | What's the right session lifecycle when a period is REOPENED (after lock)? Reopen the prior Shield session (if not purged), or open a new one and accept the re-id discontinuity? | TB PM | Phase T2 |
| 5 | The MCP agent rate-limit (100 req/60s) is separate from Shield's tenant rate limit (60/min default). If a firm uses both, do they need a per-app spend cap override? | TB lead + Shield ops | Phase T6 |
| 6 | The "preparer_notes" / "reviewer_notes" columns hold free-text comments. If Shield over-redacts a casual reference like "see Joe's W-2 page 2", does the AI suggestion quality drop? Need a fixture for this. | Shield owner | Phase T5 (QA corpus) |

---

## Cross-references

- **Shield BUILD_PLAN.md §1** — compliance objectives.
- **Shield `compliance/recognizers.md`** — recognizer set.
- **Shield `compliance/integrations/README.md`** — common patterns.
- **MyBooks integration plan** — sibling app with same default policy.
- **TB `.appliance/manifest.json`** — env-var surface.
- **TB `server/src/lib/aiClient.ts:117, 202`** — the two SDK constructor sites.
- **TB `server/src/lib/llmProvider.ts:103–110`** — the SSE streaming path.
- **TB `server/src/routes/bankStatementPdfImport.ts:58–69`** — the manual account-mask to remove.
