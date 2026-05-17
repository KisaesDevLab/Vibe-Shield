# Vibe MyBooks → Vibe Shield integration plan

**Target app:** [Vibe-MyBooks](https://github.com/KisaesDevLab/Vibe-MyBooks)
**Repo path (local):** `C:\Users\kwkcp\Projects\myBooks`
**Shield version this plan targets:** `v1.1.4+` (admin UI, image backends, SSE retry-after)
**Plan version:** 1.0 (initial)

---

## § 1. Mission

MyBooks routes every Anthropic call through Vibe Shield so that no bank statement memo, customer name, account number, EIN, tax ID, vendor invoice, or receipt image ever reaches the Anthropic API as cleartext. The five AI services (transaction categorization, receipt OCR, bill OCR, statement parser, chat assistant) all switch from the direct `@anthropic-ai/sdk` to the Shield-fronted client. Output text returned by Claude is re-identified at the Shield boundary so the bookkeeper sees the original names, accounts, and amounts — Anthropic never does.

This is the lowest-risk integration in the suite: MyBooks already has the right architecture (a single `AnthropicProvider` class wrapping the SDK; `aiConfig.piiProtectionLevel` column already exists in the schema). The integration is mostly a one-file SDK swap plus image-pipeline routing through Shield's `/redact-image`. Default policy: `cpa-bookkeeping-balanced` (re-id on response, no operator materialize path — different from the Converter).

---

## § 2. PII surface inventory

### 2.1 Customer data (highest sensitivity)

Source tables (`packages/api/src/db/schema/contacts.ts`):

| Field | Reaches Anthropic today? | Reaches Anthropic post-Shield? |
|---|---|---|
| `contacts.displayName`, `firstName`, `lastName` | Yes (in chat context, statement parser results) | No — tokenized to `<PERSON_n>` |
| `contacts.email` | Yes | No — tokenized to `<EMAIL_ADDRESS_n>` |
| `contacts.phone` | Yes | No — tokenized to `<PHONE_NUMBER_n>` |
| `contacts.billingLine1/2`, `city`, `state`, `zip`, `country` | Yes (in chat, AI-generated invoices) | No — tokenized to `<LOCATION_n>` |
| `contacts.taxId` (SSN/EIN) | Yes | No — tokenized to `<US_SSN_n>` / `<US_EIN_n>` |

### 2.2 Transaction data

Source tables (`packages/api/src/db/schema/transactions.ts`, `banking.ts`):

| Field | Reaches Anthropic today? | Notes |
|---|---|---|
| `transactions.memo`, `internalNotes` | Yes (categorization service) | Often contains payee names, sometimes amounts in narrative form |
| `transactions.payeeNameOnCheck`, `payeeAddress` | Yes (check-printing AI feature, if used) | PERSON + LOCATION |
| `transactions.vendorInvoiceNumber` | Yes | Sometimes account-fragment shaped |
| `bankFeedItems.description` | Yes (the canonical categorization input) | Most common PII path |

### 2.3 Attachments (images + PDFs)

Source tables (`packages/api/src/db/schema/attachments.ts`):

| Document type | Path | PII payload |
|---|---|---|
| Receipt images (JPG/PNG/TIFF/WEBP) | `POST /api/v1/attachments` | Vendor name, total, sometimes cardholder name printed on receipt |
| Vendor invoices (PDF/image) | Same route | Vendor name + tax ID, customer name + address, line items |
| Bank statement PDFs | Same route | Account holder, address, account number, routing number, every transaction memo |
| 1099 / W-2 / W-9 forms (uploaded by user) | Same route | SSN/EIN, full legal name, address |

**Max file size today: 10 MB. Allowed MIME types: 11 — see `attachments.routes.ts:20–27`.**

### 2.4 Chat assistant input

Source table (`packages/api/src/db/schema/ai.ts:93–112`):

| Field | PII payload |
|---|---|
| `chatMessages.content` | Free-form user prompt — can reference any customer / transaction / vendor by name and number |
| `chatMessages.entityContext` (JSON) | Snapshot of the entity the user was viewing — full customer record, full transaction, full vendor — when message was sent |

`entityContext` is the highest-risk surface because it bundles many PII fields automatically without the user's explicit awareness.

### 2.5 What does NOT need Shield

- Login flow, 2FA, magic links — no Anthropic involvement.
- Background job scheduler, backups, webhooks — text-only operational; no AI calls.
- Storage providers (S3, Dropbox, Google Drive, OneDrive) — file bytes go to operator-controlled storage; not Anthropic.

---

## § 3. Current Anthropic touchpoints

All Anthropic API access flows through ONE provider class. This is the integration win — replacing this single class catches every other AI service.

### 3.1 The provider

| File | Lines | What |
|---|---|---|
| `packages/api/src/services/ai-providers/anthropic.provider.ts` | 5 | `import Anthropic from '@anthropic-ai/sdk'` |
| same | 16 | `this.client = new Anthropic({ apiKey })` |
| same | 20–42 | `complete()` — text completion via `client.messages.create({ model, max_tokens, system, messages })` with `signal` support for cancellation |
| same | 44–68 | `completeWithImage()` — vision via the same `messages.create` shape with base64 image content blocks |
| `packages/api/src/services/ai-providers/index.ts` | 30–34 | `getProvider('anthropic', config, model)` — on-demand instantiation per request |

**Model: hardcoded `claude-sonnet-4-20250514`** at provider construction. Configurable per-call via `preferredModel` parameter on each service method.

### 3.2 Call sites (downstream services that use the provider)

| Service file | What it sends to Anthropic | PII risk |
|---|---|---|
| `ai-categorization.service.ts` | Transaction descriptions (`bankFeedItems.description` or `transactions.memo`) | High — payee names + sometimes amounts |
| `ai-receipt-ocr.service.ts` | Receipt image (vision) | High — vendor name, total, sometimes cardholder |
| `ai-bill-ocr.service.ts` | Vendor invoice image (vision) | High — vendor tax ID, customer name + address |
| `ai-statement-parser.service.ts` | Bank statement extracted text or image | Very high — account holder, account number, routing, all transactions |
| `chat.routes.ts` + `chat.service.ts` | Chat message + `entityContext` JSON | Highest — bundles multiple PII fields per message |

### 3.3 API key handling

`packages/api/src/services/ai-providers/index.ts:34` retrieves the key from the `aiConfig.anthropicApiKeyEncrypted` column and decrypts via `utils/encryption.ts`. **There is no `ANTHROPIC_BASE_URL` override mechanism today.** Adding one is part of Phase 1.

---

## § 4. Architecture decisions

### 4.1 Replace at the provider class, not at every service

The 5 AI services all funnel through `AnthropicProvider`. Replacing `import Anthropic from '@anthropic-ai/sdk'` with `import VibeShield from '@kisaesdevlab/vibe-shield-client'` at `anthropic.provider.ts:5` and `new VibeShield(...)` at line 16 captures every downstream service automatically. No changes to call sites.

### 4.2 Image redaction: route through Shield's `/redact-image`, not direct vision

Today: receipt/bill/statement uploads → Tesseract local OCR → Anthropic vision call with the image bytes.

Post-Shield: receipt/bill/statement uploads → Shield's engine `/redact-image` (which already does Tesseract + face detection + barcode + masking) → the **masked image** is what reaches Claude. The token map comes back with the response.

This means the local Tesseract step in MyBooks becomes redundant; remove or keep as offline fallback per `aiConfig.piiProtectionLevel`.

### 4.3 Reuse `aiConfig.piiProtectionLevel` for the policy choice

The schema already has a per-tenant `piiProtectionLevel` enum (`strict | standard | permissive`). Map this to Shield policies:

| `piiProtectionLevel` | Shield policy |
|---|---|
| `strict` | `cpa-bookkeeping-strict` (ZDR required, no materialize, all backstops fail-closed) |
| `standard` | `cpa-bookkeeping-balanced` (re-id allowed, balanced backstops) — default |
| `permissive` | `cpa-bookkeeping-balanced` (same as standard; see note) |

Note: Shield ships three CPA-shaped policies — `cpa-bookkeeping-strict`, `cpa-bookkeeping-balanced`, and `cpa-converter-output` (Converter-specific). There is no separate "permissive" policy today; mapping `permissive → balanced` is the right behaviour because Shield's recognizer set is uniform across policies and "permissive" in MyBooks' UI is really about backstop strictness, not entity coverage. If a future MyBooks workflow needs a genuinely more relaxed posture (e.g. lower-confidence backstops fail-open), file a Shield issue to add `cpa-bookkeeping-permissive` to `apps/gateway/src/policy/built-in.ts` before relying on it here.

Add the policy name to every Shield request via the `policy_name` field. Shield's PolicyResolver handles the rest.

### 4.4 Session lifecycle: per-bookkeeping-period

Each MyBooks fiscal period gets one Shield session. Categorization, receipt OCR, statement parsing, chat — all within one period share a session ID. This means re-identifying a vendor name in turn 1 of a chat thread produces the same `<PERSON_5>` token in turn 17.

When MyBooks closes a period, it should call `Shield DELETE /v1/sessions/<id>` so the vault discards the DEK and tokens for that period become unrecoverable. The endpoint is idempotent: a second DELETE returns 204 either way.

### 4.5 No materialize path

`cpa-bookkeeping-balanced` does not allow materialize. The bookkeeper sees re-identified cleartext in the response, but there's no admin path to fetch raw tokens. This is intentional and different from the Converter.

If MyBooks later adds a "redacted export for accountant review" feature, file a Shield issue to add an export-shaped policy (e.g. `cpa-bookkeeping-export` with `reid.mode = 'none'` and an allow-listed materialize path) — not `cpa-converter-output`, which is shaped for OFX/QFX and only allows the `converter` appId.

---

## § 5. Phased implementation

Each phase ends with explicit acceptance criteria. The app team estimates effort; Shield doesn't.

### Phase M0 — Shield is reachable from MyBooks (pre-work)

- [ ] Vibe Appliance has `vibe-shield` enabled (per `appliance/INSTALL.md` in the Shield repo).
- [ ] MyBooks operator can `curl http://vibe-shield-gateway:8080/health` from a MyBooks container.
- [ ] An admin issues a tenant API key via Shield admin UI for `tenantId: mybooks-prod`. Key looks like `vs_live_*`.

**Acceptance:** `curl -H "Authorization: Bearer vs_live_..." http://vibe-shield-gateway:8080/v1/messages` returns a Shield envelope (400 invalid request on empty body is success — proves auth path works).

### Phase M1 — SDK swap + env wiring

- [ ] Add `@kisaesdevlab/vibe-shield-client` to `packages/api/package.json`. Same SDK shape as `@anthropic-ai/sdk`.
- [ ] Replace `import Anthropic from '@anthropic-ai/sdk'` at `anthropic.provider.ts:5`.
- [ ] Replace `new Anthropic(...)` at `anthropic.provider.ts:16` with the Shield client.
- [ ] Add `ANTHROPIC_BASE_URL` env var to `packages/api/src/config/env.ts` (zod-validated URL). Default for appliance deploys: `http://vibe-shield-gateway:8080`.
- [ ] Update `.appliance/manifest.json` env block:
  - `ANTHROPIC_API_KEY` doc note: "Now a `vs_live_*` key issued by Vibe Shield; the real Anthropic key never leaves Shield."
  - Add `ANTHROPIC_BASE_URL` with `from: static:http://vibe-shield-gateway:8080`.
- [ ] Update `.env.example`.
- [ ] Run existing test suite. **Should pass with no AI-test changes.**

**Acceptance:** Existing AI integration tests pass when pointed at a running Shield instance (use Shield's stub Anthropic for CI). `pnpm test` green. The categorization service emits a request that has `<PERSON_n>` / `<EMAIL_ADDRESS_n>` / etc. in the prompt body when inspected against Shield's audit log.

### Phase M2 — Policy + session lifecycle

- [ ] In `AnthropicProvider.complete()` and `completeWithImage()`, attach the policy name from `aiConfig.piiProtectionLevel`:

  ```ts
  await this.client.messages.create({
    model, max_tokens, system, messages,
    policy_name: piiLevelToPolicy(this.piiProtectionLevel), // Shield extension
    session_id: this.sessionId, // attached at provider construction
    ...
  });
  ```

- [ ] Open a Shield session at the start of each MyBooks "interaction." For chat, this is the chat conversation; for one-off categorization, this is the request itself.
- [ ] Call `Shield DELETE /v1/sessions/<id>` from MyBooks' "close period" handler.
- [ ] Add config UI page: Settings → AI → PII Protection Level (dropdown: strict / standard / permissive).

**Acceptance:** Sending the same vendor name twice within one session produces the same `<PERSON_n>` token (visible in Shield audit). After period close, attempting re-id on that session's tokens returns Shield's "session expired" envelope.

### Phase M3 — Image pipeline routing

- [ ] In the receipt/bill/statement upload handlers, replace the local Tesseract → Anthropic vision flow with:
  1. POST the image to Shield's `/redact-image` endpoint
  2. Receive back: `{ masked_image_base64, token_map, ocr_text }`
  3. Send the masked image + OCR text to Claude via `AnthropicProvider.completeWithImage`
  4. The response is re-identified by Shield's standard path

- [ ] Remove the in-process Tesseract dependency from `package.json` if no longer needed (or keep as offline fallback when `piiProtectionLevel === 'permissive'`).
- [ ] Store the masked image (not the original) in the attachment record. The original goes to the storage provider as before but is NEVER re-sent to Anthropic.

**Acceptance:** Upload a bank statement PDF containing `Account # 234567890123`. Verify the Shield audit log shows the request body contained `<US_BANK_ACCOUNT_1>` not the digits. Verify the response shown to the user contains the original digit string.

### Phase M4 — Fail-closed contract

- [ ] When Shield returns 503 (engine unavailable), MyBooks surfaces a user-visible error: "AI features are temporarily unavailable. Please retry in 30 seconds."
- [ ] When Shield returns 429 (rate-limited), MyBooks honors the `Retry-After` header.
- [ ] When Shield returns 403 (spend cap reached), MyBooks shows the operator a clear admin error: "Your monthly Anthropic spend cap has been reached. Contact your firm administrator."
- [ ] **No code path** silently falls back to direct Anthropic, local LLM, or "best-effort" categorization without AI.

**Acceptance:** With Shield stopped (`docker stop vibe-shield-gateway`), every AI-driven UI action shows the appropriate user-facing error. No 500s; no hangs; no silent degradation.

### Phase M5 — Test coverage + audit hygiene

- [ ] Add 5+ synthetic fixtures to Shield's `qa/corpus/synthetic/` covering MyBooks-specific document shapes (Chase / BofA / WF / Amex statement headers; receipt formats; W-2 / 1099-NEC). MyBooks contributes the fixtures; Shield reviews + merges.
- [ ] Audit-log scrub: grep MyBooks' container logs for cleartext PII strings after running the test suite. Expected count: **0**.
- [ ] Add a feature flag `MYBOOKS_USE_SHIELD` (default true on appliance) so the operator can disable the integration for diagnostic comparison without redeploying.

**Acceptance:** `pnpm --filter @vibe/api test:integration` passes; `grep -r '234-56-7890\|sample-payee\|john@example.com' /var/log/mybooks/` returns no matches after a full integration run.

---

## § 6. Hard rules for this integration

Extensions to the global hard rules:

1. **No `@anthropic-ai/sdk` import outside `anthropic.provider.ts`.** Enforce via the existing `scripts/check-no-anthropic-direct.sh` in the Shield repo (which already scans cross-repo via filename patterns) OR via a MyBooks-local lint rule. A second `new Anthropic(...)` anywhere in MyBooks is a hard-rule violation.

2. **`piiProtectionLevel='permissive'` does not bypass Shield.** Permissive only changes which Shield policy applies; it does NOT route requests directly to Anthropic. Removing Shield from the request path is forbidden.

3. **No "raw text" debug mode that sends unredacted content.** Engineering convenience cannot be a privacy escape hatch.

4. **`entityContext` MUST be redacted as a whole JSON object.** Shield's redactor walks nested JSON; MyBooks must NOT pre-serialize entityContext to a single string before sending (which would defeat per-field redaction).

5. **Bank statement images: the masked image, not the original, goes to Anthropic.** The original stays in MyBooks' storage provider; the masked variant is the AI input.

---

## § 7. Test plan

### 7.1 Shield-side regression (every MyBooks PR)

Run Shield's QA harness:

```
QA_SPACY_MODEL=en_core_web_lg uv run --with pip python -m qa.recall_precision
```

Must pass the precision floor on every entity type. MyBooks contributes fixtures (see §5 Phase M5).

### 7.2 MyBooks-side integration tests

Add a `MyBooks → Shield → mock Anthropic` integration suite covering:

- **categorization happy path**: send transaction description with a PERSON; verify outbound to mock-Anthropic has `<PERSON_n>` not the name; verify response is re-identified before reaching the bookkeeper UI.
- **session reuse**: 3 categorization calls with the same payee; verify identical `<PERSON_n>` token across all 3.
- **policy override**: with `piiProtectionLevel='strict'`, verify the `policy_name` field on Shield requests is `cpa-bookkeeping-strict`; with `'standard'` or `'permissive'`, verify it is `cpa-bookkeeping-balanced` (the two MyBooks UI levels collapse to the same Shield policy until a `cpa-bookkeeping-permissive` is added — see §4.3).
- **fail-closed on Shield down**: stop the mock Shield; verify categorization returns a 503 with the expected user-facing message.
- **fail-closed on 429**: mock Shield returns 429 with `Retry-After: 30`; verify MyBooks honors it.

### 7.3 Cleartext-leak audit

After every full integration test run, grep:

```bash
# In MyBooks container logs
grep -rE 'Maria Reyes|234-56-7890|012345678|hector\.diaz' /var/log/mybooks/

# In MyBooks audit / activity tables
psql vibe_mybooks_db -c "SELECT count(*) FROM activity_log WHERE payload::text LIKE '%Maria%';"

# In MyBooks attachments storage (the original images CAN contain PII;
# the question is whether any masked-image record holds cleartext)
ls /data/uploads/masked/ | head -5 | xargs -I{} python -c "import PIL.Image, pytesseract; print(pytesseract.image_to_string(PIL.Image.open('{}')))" | grep -E '234-56-7890|...'
```

All three must return **zero matches** for the PII strings used in the integration tests.

---

## § 8. Rollout

### 8.1 Pre-rollout

- [ ] Phase M0–M5 complete in a feature branch.
- [ ] All integration tests pass in CI against a stub Shield.
- [ ] One Vibe Appliance environment (firm-internal staging) runs MyBooks-with-Shield against a real Shield gateway for 1 week with synthetic load.

### 8.2 Canary

- [ ] Enable `MYBOOKS_USE_SHIELD=true` for one production firm with operator consent.
- [ ] Monitor Shield's `vs_recognizer_misses` table — any high-severity miss attributed to MyBooks' document shapes triggers a hold.
- [ ] Compare AI feature acceptance rates (user accepts the AI's suggestion) pre/post-Shield. Expected: no statistically significant change. Significant drop means redaction is over-firing and the operator's UI experience degraded.

### 8.3 General availability

- [ ] After 30 days of canary with zero P0/P1 incidents and a clean cleartext-leak audit (re-run §7.3 on production logs).
- [ ] Default `MYBOOKS_USE_SHIELD=true` on the Vibe Appliance.
- [ ] Update the firm-installer flow to issue the `vs_live_*` key automatically when both Shield and MyBooks are enabled.

### 8.4 Reverting (the escape hatch)

If a P0 redaction issue ships, the firm operator can set `MYBOOKS_USE_SHIELD=false` (env var on the api container) and restart. MyBooks reverts to direct Anthropic. This is documented as the only acceptable bypass and only the operator (with explicit incident-response authorization) can flip it. The bypass logs an audit event and counts as a compliance incident — even if used briefly.

---

## § 9. Open questions

| # | Question | Owner | Resolution before |
|---|---|---|---|
| 1 | Does the chat assistant's `entityContext` need a separate Shield policy? It bundles per-entity PII and may benefit from `chat-context-strict` (no materialize, full redaction) regardless of the firm's `piiProtectionLevel` setting. | MyBooks PM + Shield owner | Phase M2 |
| 2 | What happens to the existing `aiConfig.anthropicApiKeyEncrypted` column during migration? Two options: (a) repurpose it for the Shield `vs_live_*` key; (b) add a new `aiConfig.shieldTenantKeyEncrypted` column and deprecate the old one over 2 releases. | MyBooks lead | Phase M1 |
| 3 | When a customer is renamed in MyBooks, the per-period Shield session has a token bound to the OLD name. Does MyBooks need to invalidate the session and reopen, or is the small re-id continuity hit acceptable? | MyBooks PM | Phase M2 |
| 4 | Bank statement parsing is Phase 3 of MyBooks' own AI pipeline (after rules + history). Should Shield see only the descriptions that the first two layers couldn't classify, or every description for consistent token allocation? | MyBooks lead | Phase M3 |
| 5 | The chat `entityContext` snapshot may include thousands of past transactions for a single customer. Does Shield's per-tenant rate limit (default 60/min) need a per-app override for MyBooks' chat? | MyBooks PM + Shield ops | Phase M4 |
| 6 | Vendor invoice OCR includes line items with prices — sometimes hand-written. Tesseract may misread; does Shield's confidence-30 floor drop too many real PII tokens on those? | Shield owner | Phase M5 (QA corpus) |

---

## Cross-references

- **Shield BUILD_PLAN.md §1** — the six compliance objectives.
- **Shield `compliance/recognizers.md`** — current recognizer set + measured rates.
- **Shield `compliance/integrations/README.md`** — common patterns reused here.
- **Shield `appliance/INSTALL.md`** — how the Vibe Appliance enables Shield.
- **MyBooks `.appliance/manifest.json`** — declares the env vars Shield depends on.
- **MyBooks `packages/api/src/services/ai-providers/anthropic.provider.ts`** — the single integration point.
