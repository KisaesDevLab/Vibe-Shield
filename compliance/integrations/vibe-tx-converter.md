# Vibe Transactions Converter → Vibe Shield integration plan

**Target app:** [Vibe-Transaction-Convertor](https://github.com/KisaesDevLab/Vibe-Transaction-Convertor)
**Repo path (local):** `C:\Users\kwkcp\Projects\Vibe-Transaction-Convertor`
**Shield version this plan targets:** `v1.1.4+` (with the `cpa-converter-output` policy + materialize endpoint)
**Plan version:** 1.0 (initial)

---

## § 1. Mission

The Converter is **the only Vibe app where the goal is NOT to keep PII away from the customer**. The whole point of OFX/QFX/QBO export is to write the original account number into `<ACCTID>` so QuickBooks / Quicken / Xero can re-import the bank statement. The Converter inverts the standard Shield policy: tokenize on the way IN (to the LLM extractor); materialize on the way OUT (to the file the user downloads).

The architecture has a quirk that makes this easier than it looks: **the account number is never extracted from the PDF by the LLM**. It is **operator-input** when the account record is created; it lives in `accounts.accountNumber` (Postgres); and it is only re-introduced at OFX render time. The LLM sees only the masked `last-4` form from the statement header.

So the integration is in two halves:

1. **LLM side** (smaller): replace the vendored raw-fetch Anthropic provider with the Shield client. Apply the `cpa-converter-output` policy + per-conversion session. Tokenize the things the LLM sees: bank name, statement period dates (whitelist), transaction descriptions, masked-last-4 (already non-PII). Most of the LLM input is amounts + dates + already-masked digits — low PII surface compared to MyBooks.

2. **Export side** (the unique part): when the user clicks "Export to OFX," the route loads `account.accountNumber` from Postgres (cleartext at rest, encrypted DEK-per-tenant via Shield's vault), calls `Shield POST /v1/sessions/<id>/materialize` with the `cpa-converter-output` policy, receives the cleartext account number, writes it into `<ACCTID>` in the XML.

The `cpa-converter-output` policy is the only Shield policy that permits the materialize call — every other policy returns 403. This is the canonical "I need cleartext back" use case.

---

## § 2. PII surface inventory

### 2.1 The export-side fields (the unique surfaces)

These appear in the **output file the user downloads**. The Converter MUST produce them; this is not redactable. The Shield integration's job is to ensure they're held encrypted at rest and surfaced ONLY through the materialize path.

| OFX/QFX/QBO field | Source | PII content |
|---|---|---|
| `<ACCTID>` | `accounts.accountNumber` | Full account number (operator-input) |
| `<BANKID>` | `accounts.routingNumber` OR `accounts.intuBid` | 9-digit ABA routing OR Intuit BID |
| `<ORG>` | `accounts.intuOrg` | Bank organization name (e.g., "Wells Fargo") |
| `<NAME>` (per txn) | transaction description (cleansed) | Merchant / payee — sometimes contains names |
| `<MEMO>` (per txn) | transaction description (raw) | Same as `<NAME>` but uncleansed |
| `<DTPOSTED>` (per txn) | transaction date | Calendar date (Shield whitelist) |
| `<CHECKNUM>` (per txn) | check number when present | Check number (numeric) |

### 2.2 The LLM-side fields (the standard surfaces)

The LLM ingests OCR'd markdown from the PDF and returns structured extraction. PII surfaces here:

| Field LLM sees | LLM extracts? | PII content |
|---|---|---|
| Account holder name (if printed in statement header) | NO — not in schema | Yes |
| Account number (full) | NO — schema captures only `masked_number` (last-4) | The full number is in the OCR text BUT the prompt instructs Claude to mask; the extractor enforces `last-4` via Zod |
| Routing number | NO — not in schema | Sometimes printed on the statement |
| Bank name | YES (`institution.name`) | Not PII |
| Statement period | YES (`period.start`, `period.end`) | Calendar date (whitelist) |
| Balances (opening, closing, ledger) | YES | Numeric; sometimes transaction tagging surfaces account-fragment shaped digits |
| Transaction descriptions | YES (`transactions[].description`) | Often payee names; sometimes phone numbers for customer service refs |

**The Shield integration must tokenize:**
- Bank name → keep (not PII)
- Statement period → whitelist (calendar date)
- Balances → whitelist (currency)
- Transaction descriptions → tokenize per the standard recognizer pipeline
- Account holder name (if present in OCR markdown) → tokenize before reaching Claude

### 2.3 Cleartext at rest

| Table.column | Cleartext? | Notes |
|---|---|---|
| `accounts.accountNumber` | **Cleartext today** | OPERATOR-input via UI. Must be encrypted via Shield's per-tenant DEK post-integration. |
| `accounts.routingNumber` | **Cleartext today** | Same — must be encrypted. |
| `accounts.intuBid`, `intuOrg` | Cleartext (not PII; public BID) | Stay as-is. |
| `transactions.description`, `name`, `memo` | Cleartext today | These come from OCR; some are PII. Storage decision: encrypt at rest (per-tenant DEK) OR tokenize-on-write + materialize-on-export. See §4.3. |
| `statements.*` (balances, dates) | Cleartext | Numeric / dates only; no PII. |

### 2.4 What does NOT need Shield

- Login / session auth — no Anthropic.
- BullMQ extraction worker scheduler — orchestration only.
- File-cleanup maintenance — operational.
- Source PDF storage at `$DATA_DIR/source/{sha256}/pdf` — the PDF itself is operator-controlled; Shield's job is to keep its content from leaking to Anthropic, not to re-encrypt the original.
- The local Vibe LLM Gateway path (Qwen3-8B via `LocalGatewayProvider`) — local-only; doesn't reach Anthropic; out of scope for Shield. The Converter can stay multi-provider.

---

## § 3. Current Anthropic touchpoints

### 3.1 The vendored raw-fetch provider

**Critical:** the Converter does NOT use the `@anthropic-ai/sdk`. It uses a hand-written `fetch()` implementation in:

| File | Lines | What |
|---|---|---|
| `packages/extractor/src/llm-client.ts` | 540–552 | `AnthropicProviderOptions` + constructor. Honors `ANTHROPIC_BASE_URL` env var (already!). |
| same | 613–678 | `callAnthropic(messages, tool)` → raw `fetch()` POST to `${baseUrl}/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01` + tool-use spec |
| same | 680–742 | `extract(markdown)` orchestrates: assembles exemplars + user prompt + tool spec, calls `callAnthropic`, retries on missing fields |

**No `@anthropic-ai/sdk` imports anywhere in the repo.** This is a huge integration win:

- The "swap" is just changing the URL the `fetch()` POSTs to. Shield's gateway is `/v1/messages`-compatible with Anthropic's API. Set `ANTHROPIC_BASE_URL=http://vibe-shield-gateway:8080` and the `apiKey` to the `vs_live_*` Shield key — everything else works.
- No SDK version compatibility to worry about.
- No streaming (the Converter doesn't stream; it's pure batch extraction).
- No tool-use streaming complications (the tool input is a tool_use response block, not a streamed assembly).

### 3.2 Call sites

Only one caller: the BullMQ extraction worker.

| File | Lines | What |
|---|---|---|
| `apps/api/src/jobs/extraction.worker.ts` | 850–909 | Provider selection (LocalGateway vs Anthropic vs OpenAI-compatible); calls `provider.extract(markdown, opts)` |
| `packages/extractor/src/llm-client.ts` | 680–742 | `extract()` is the entry point; reminder-retry loop for missing extraction fields |

### 3.3 Base URL — already honored!

`llm-client.ts:540–552`:

```ts
this.baseUrl = (
  opts.baseUrl ??
  process.env.ANTHROPIC_BASE_URL ??
  'https://api.anthropic.com'
).replace(/\/$/, '');
this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
```

**This is the only Vibe app that already supports `ANTHROPIC_BASE_URL` out of the box.** No code change for the URL flip; just the env var.

---

## § 4. Architecture decisions

### 4.1 The integration is two halves

Half A — LLM input redaction (small, standard).
Half B — materialize on export (unique, the canonical case for `cpa-converter-output`).

Half A reuses MyBooks/TB patterns; Half B is what makes this plan different.

### 4.2 Storage decision: encrypt operator-input PII via Shield's vault

`accounts.accountNumber` + `accounts.routingNumber` are operator-input AND must appear in OFX output. The integration moves these from cleartext-at-rest to encrypted-via-tenant-DEK:

- The Converter's `accounts` schema gets two new columns: `accountNumberEncrypted` (bytea), `routingNumberEncrypted` (bytea). The old `accountNumber`, `routingNumber` columns are deprecated.
- On account creation, the Converter calls `Shield POST /v1/sessions/<conversion_session_id>/tokenize` to encrypt the cleartext under the Shield-managed DEK. Stores the wrapped ciphertext.
- On export, the Converter calls `Shield POST /v1/sessions/<conversion_session_id>/materialize` (which is policy-gated to `cpa-converter-output`) to decrypt and use in the OFX writer.
- During migration: a one-time backfill encrypts existing cleartext rows.

**Why through Shield's vault and not the Converter's own crypto:** the Converter's database is in the same Postgres instance as MyBooks and TB. If the Converter rolls its own DEK, an operator compromise of the Postgres key gets the Converter's data without going through Shield's per-tenant DEK + KEK chain. Routing through Shield's vault gives the Converter the same crypto posture as the rest of the Shield-protected vault.

### 4.3 Transaction descriptions: tokenize-on-write OR encrypt-at-rest

`transactions.description`, `transactions.name`, `transactions.memo` come from OCR + LLM-cleansing. These contain PII. Two options:

**Option A (recommended for v1): Encrypt at rest via Shield's vault.**

- Store ciphertext only. On UI render, materialize via `cpa-converter-output` (which is what the user already has authority to see).
- Same posture as `accountNumberEncrypted`.

**Option B: Tokenize on write; materialize at export.**

- Store `<PERSON_n>` tokens in the description columns. UI renders by calling Shield's per-session re-id endpoint. Export materializes for the OFX file.
- More work; only useful if the UI needs to differentiate "I'm allowed to see this" vs "I'm allowed to export this." For the Converter's single-firm posture, the UI viewer == the OFX exporter (same person), so the policy gate is the same.

**Pick Option A for v1.** Revisit if a future multi-role UI emerges.

### 4.4 Session lifecycle: per-conversion (per-statement)

A "conversion" is one PDF upload → one OFX/CSV/QBO/QFX output. The Shield session lifecycle maps to that:

- **Open** session at upload (`POST /api/uploads/:accountId` in `uploads.ts:70`). Session ID stored on the `statements` row.
- **Use** session ID on every LLM extraction call (the recognizer pipeline tokenizes the markdown; the tokens are deterministic within the session).
- **Use** session ID at export (materialize call uses this session's vault).
- **Purge** session after the user downloads the export (or after a configurable retention window — default 30 days, matching the existing maintenance worker's PDF retention).

Multi-statement batches: each statement gets its own session. The user's "import 30 statements at once" flow opens 30 sessions in parallel.

### 4.5 The materialize call gate

Shield's `POST /v1/sessions/<id>/materialize` checks the session's policy. Only `cpa-converter-output` allows the call. The Converter's export route MUST set the session's policy to `cpa-converter-output` at session-open time:

```ts
// uploads.ts (post-Shield)
const session = await shield.sessions.create({
  policy: 'cpa-converter-output',
  user_id: req.user.id,
});
await db.update(statements).set({ shieldSessionId: session.id }).where(...);
```

If the Converter accidentally opens a session under `cpa-bookkeeping-balanced`, the export's materialize call returns 403 and the user can't download. This is the right failure mode (clear error vs silent breakage), but the integration MUST default the policy correctly.

### 4.6 GLM-OCR upstream

The Converter calls a local GLM-OCR HTTP service (`glm-ocr-client.ts`). GLM-OCR is local-only; it doesn't reach Anthropic. **No Shield integration needed for the OCR call itself.** The OCR'd markdown that comes back IS what gets sent to Anthropic, so the redaction happens on the LLM-input side (Half A), not the OCR side.

### 4.7 The reminder-retry pattern

`llm-client.ts:680–742` extracts twice if the first response misses required fields. Both retries go through the same Shield session, so:

- The retry's request body is also redacted.
- Token allocations from the first attempt persist; the second attempt sees the same tokens.

No special handling needed.

### 4.8 No streaming

The Converter doesn't stream. The LLM is a batch extractor: one call, one tool_use response, one parse. Shield's non-streaming path applies. (This is why Tax Research is harder than the Converter despite the Converter being the higher-PII app.)

### 4.9 Pricing table

`llm-client.ts:497–504` holds a hardcoded `ANTHROPIC_PRICE_TABLE_DEFAULT` for cost telemetry. Same comment as Tax Research's §4: Shield passes through Anthropic's `usage` block unchanged, so cost calc still works.

---

## § 5. Phased implementation

### Phase C0 — Shield reachable + `cpa-converter-output` policy verified

- [ ] Vibe Appliance has Shield enabled.
- [ ] Converter operator can `curl http://vibe-shield-gateway:8080/health`.
- [ ] Tenant API key issued for `tenantId: tx-converter-prod`, `appId: tx-converter`.
- [ ] Verify `cpa-converter-output` policy exists in Shield (`GET /v1/admin/policies`). If missing, Shield team adds it before Converter kickoff.
- [ ] Verify the policy's `materialize` field is true.

**Acceptance:** `curl -X POST -H "X-Admin-Key: ..." -H "content-type: application/json" -d '{"policy":"cpa-converter-output"}' http://vibe-shield-gateway:8080/v1/sessions/test/materialize` returns a Shield envelope (400 "session not found" is success — proves the policy gate passes auth).

### Phase C1 — Half A: LLM SDK swap (env var flip + key)

- [ ] No code change needed (base URL already honored).
- [ ] Set `ANTHROPIC_BASE_URL=http://vibe-shield-gateway:8080` in the Converter's container env.
- [ ] Set `ANTHROPIC_API_KEY` to the `vs_live_*` Shield key (issued in C0).
- [ ] Update `.appliance/manifest.json` to declare these new defaults.
- [ ] Run an extraction against a synthetic statement. Verify Shield's audit log captures the request with the OCR markdown's PII tokenized.

**Acceptance:** A real PDF runs through extraction; Shield audit shows the prompt with `<PERSON_n>` / `<US_EIN_n>` etc. where the original markdown had cleartext. The extraction result still validates against the Zod schema (the LLM returns the same shape — token names in the descriptions get re-identified on the way back).

### Phase C2 — Half A: policy + session in extraction

- [ ] Open a Shield session at upload (modify `uploads.ts:70`):
  ```ts
  const session = await shield.sessions.create({
    policy: 'cpa-converter-output',
    user_id: req.user.id,
  });
  await db.update(statements)
    .set({ shieldSessionId: session.id })
    .where(eq(statements.id, statementId));
  ```
- [ ] Pass `shieldSessionId` to the BullMQ job. In `extraction.worker.ts`, attach the session ID + policy to the Anthropic call (the Shield client honors these as standard fields).
- [ ] Verify: the OCR markdown for a statement containing `Account holder: Maria Reyes` reaches Claude as `Account holder: <PERSON_1>`.

**Acceptance:** Shield audit for the extraction job shows the masked prompt. Extraction returns the same schema as before. `statements.shieldSessionId` is populated for every new upload.

### Phase C3 — Half B: store account PII via Shield vault

- [ ] Migrate `accounts` table:
  - Add `accountNumberEncrypted` (bytea), `routingNumberEncrypted` (bytea), `accountNumberSessionId` (uuid).
  - On account create / update, call `Shield POST /v1/sessions/<id>/tokenize` (or the equivalent vault-write endpoint — see Shield's `TokenVault.allocate` shape). Store the ciphertext.
  - Backfill existing rows: for each existing account, open a Shield session under `cpa-converter-output`, tokenize the cleartext, store the ciphertext, drop the cleartext columns.
- [ ] **CRITICAL:** the backfill must happen during the Phase C3 deploy with the gateway down for writes. Operators must follow the runbook (no live writes during backfill).
- [ ] After backfill, deprecate the cleartext `accountNumber`, `routingNumber` columns. Two-release deprecation: keep the columns for one release with read-fallback so a rollback is possible.

**Acceptance:** A new account creation results in cleartext NEVER hitting Postgres (verify by sniffing Postgres logs during the test). Reading the account via the UI materializes correctly under the `cpa-converter-output` policy.

### Phase C4 — Half B: materialize at export

- [ ] In `exports.ts:118–173` (the OFX assembly), replace:
  ```ts
  const ofxStmt: Stmt = {
    bankAccountInfo: {
      bankId: account.routingNumber, // OLD: cleartext from DB
      accountId: account.accountNumber, // OLD: cleartext from DB
      ...
    },
  };
  ```
  with:
  ```ts
  const materialized = await shield.sessions.materialize({
    sessionId: statement.shieldSessionId,
    policy: 'cpa-converter-output',
    fields: {
      accountId: account.accountNumberEncrypted,
      bankId: account.routingNumberEncrypted,
    },
  });
  const ofxStmt: Stmt = {
    bankAccountInfo: {
      bankId: materialized.bankId,
      accountId: materialized.accountId,
      ...
    },
  };
  ```
- [ ] The XML writer (`xml-writer.ts:36–120`) sees the materialized cleartext exactly once, writes it to the buffer, and returns. The cleartext is held in memory only for the duration of one HTTP response.
- [ ] **Never log the materialized values.** The materialize call's success/failure is auditable; the values themselves are not loggable.

**Acceptance:** Download an OFX file for a statement; verify `<ACCTID>` and `<BANKID>` contain the original cleartext numbers. Verify the Converter's logs for the same request show no cleartext. Verify Shield's audit log shows one materialize event with hashes only.

### Phase C5 — Transaction-description encryption

- [ ] Per §4.3 Option A: encrypt `transactions.description`, `name`, `memo` at rest via Shield's vault.
- [ ] On UI render of a statement detail page, materialize per-batch (one materialize call returning 50 transaction descriptions, not 50 calls).
- [ ] On OFX export, the same materialize call returns the cleartext for `<NAME>` and `<MEMO>`.
- [ ] Backfill existing transaction rows (same runbook posture as C3).

**Acceptance:** Statement detail page renders correctly with re-identified descriptions; `transactions.description` in Postgres is ciphertext; export produces correct OFX.

### Phase C6 — Session purge + retention

- [ ] When the user explicitly deletes a statement, `Shield POST /v1/sessions/<id>/purge`.
- [ ] Maintenance worker (`maintenance.worker.ts`) gains a "purge old shield sessions" sweep: any statement older than 30 days that's been exported AND the user has downloaded the file → purge.
- [ ] Document the retention policy explicitly. The cleartext-decrypt window is bounded.

**Acceptance:** After purge, attempting materialize on the session's tokens returns "session expired." The statement's audit log shows the purge event.

### Phase C7 — Fail-closed + test coverage

- [ ] When Shield is down, upload returns 503 (don't accept new statements).
- [ ] When materialize returns 403 (wrong policy), export returns 500 with a clear "policy mismatch" message + tells operator to file a Shield bug.
- [ ] When materialize returns 401 (key revoked), export returns the same 403 envelope the user gets for any auth failure.
- [ ] Cleartext-leak audit: grep Converter logs + Postgres for cleartext PII strings used in tests.

**Acceptance:** `grep -rE 'Maria Reyes|234-56-7890|012345678' /var/log/converter/` = 0; `psql vibetc -c "SELECT count(*) FROM accounts WHERE accountNumber IS NOT NULL"` = 0 after migration (column gone or NULL).

---

## § 6. Hard rules for this integration

1. **The `cpa-converter-output` policy is THE ONLY policy that allows materialize.** Any other policy MUST cause the materialize call to fail with 403. Document this in the policy comment.

2. **Cleartext account numbers MUST come from Shield's vault, NEVER directly from Postgres.** Post-Phase C3, the `accountNumber` and `routingNumber` columns are gone (or stub-null). Reading them is a hard-rule violation (compile error after the column is dropped).

3. **The materialize call returns cleartext that MUST be held in memory only.** Log lines / error messages / audit rows MUST NOT echo materialized values.

4. **`cpa-converter-output` sessions MUST be opened with explicit policy declaration.** A default-policy session that "accidentally" allows materialize is a security regression.

5. **The reminder-retry MUST use the same session as the first attempt.** Re-id continuity within the same job.

6. **The local Vibe LLM Gateway path is NOT a Shield bypass.** Operators choose Anthropic OR LocalGateway at config time. The runtime cannot silently fall back from Anthropic-via-Shield to LocalGateway-direct because of, e.g., a Shield 503.

7. **Backfill (Phase C3 + C5) MUST happen during a write-paused window.** Concurrent writes to `accountNumber` during backfill would lose the cleartext-to-ciphertext mapping.

---

## § 7. Test plan

### 7.1 Integration suite

- **Synthetic statement → OFX round-trip**: upload a synthetic Chase statement (use Shield's `qa/corpus/synthetic/statements.py` for inspiration); verify the extraction request to Shield had PII tokenized; verify the OFX output has `<ACCTID>` equal to the operator-input cleartext account number.
- **Materialize policy gate**: open a session under `cpa-bookkeeping-balanced` (the wrong policy); attempt export; verify 403.
- **Session reuse**: upload the same statement twice in the same conversion session (re-process); verify the same tokens are reused.
- **Account creation**: create an account with cleartext input via the UI; verify Postgres holds ciphertext only; verify a fresh materialize returns the input cleartext.
- **Backfill correctness**: pre-populate accounts with cleartext, run the C3 backfill script in dry-run mode + apply mode; verify all rows are migrated; verify materialize returns each row's original cleartext.

### 7.2 Shield-side regression

Converter contributes to Shield's QA corpus:
- 10+ synthetic statement OCR-markdown fixtures with payee names + amounts + account-fragment-shaped digits.
- 5+ tool_use response fixtures (the schema-validated extraction output).
- Fixtures specifically exercising the `materialize`-on-`cpa-converter-output` path.

Shield's QA harness must pass after these.

### 7.3 Cleartext-leak audit

```bash
# After a full integration suite run:
grep -rE 'Maria Reyes|234-56-7890|012345678|0123456789|hector\.diaz' /var/log/converter/
psql vibetc -c "SELECT count(*) FROM accounts WHERE accountNumber IS NOT NULL;"  # zero post-C3
psql vibetc -c "SELECT count(*) FROM transactions WHERE position('234' in description) > 0;"  # zero post-C5 (would be ciphertext)
ls /data/exports/ | head -3 | xargs grep '234567890123' || echo 'no leak in export filenames'
```

The OFX/QFX/QBO files themselves SHOULD contain cleartext (that's the point) — that's NOT a leak; it's the spec-defined behavior. Audit checks that nothing OTHER than the export file contains the cleartext.

---

## § 8. Rollout

### 8.1 Pre-rollout

- [ ] Phases C0–C7 complete in a feature branch.
- [ ] Backfill script tested on a copy of production data.
- [ ] One-week staging run against synthetic load.

### 8.2 Canary

- [ ] Enable for one firm (operator consent + a tested backup of the pre-migration database).
- [ ] Monitor:
  - Shield audit log for any non-materialize attempt to read account ciphertext.
  - OFX export success rate (any drop is a P0).
  - QuickBooks re-import success on a sample of exported files (any structural drift in the OFX would surface here).
- [ ] 30 days canary.

### 8.3 GA

- [ ] Default `TX_CONVERTER_USE_SHIELD=true`.
- [ ] Update installer to issue Converter's tenant key + flip the env var.
- [ ] Document the deprecation of the `accountNumber` cleartext columns; remove them after one release.

### 8.4 Bypass

The Converter's bypass is more dangerous than other apps' because it would re-expose cleartext that's been migrated to ciphertext. **No runtime bypass.** If Shield is unrecoverable, the operator must restore from backup and use the pre-Shield Converter. Document this explicitly.

---

## § 9. Open questions

| # | Question | Owner | Resolution before |
|---|---|---|---|
| 1 | Does Shield ship `cpa-converter-output` policy by default, or do we add it as part of C0? | Shield owner | Phase C0 |
| 2 | The vault tokenize/materialize endpoints used here — confirm they exist in Shield v1.1.4+ OR file the issue. | Shield owner | Phase C3 |
| 3 | Backfill (C3 + C5): one-shot during a maintenance window, or rolling? Rolling needs dual-read logic during the migration. | Converter lead | Phase C3 |
| 4 | If the operator types a 12-digit account number in the UI but the bank statement OCR shows a different number (typo / wrong account picked), does the export silently materialize the operator-input value, or warn? | Converter PM | Phase C4 |
| 5 | The local Vibe LLM Gateway (Qwen3-8B) — same prompt redaction posture if firms opt for local LLM? Or does local LLM see cleartext (since it never leaves the appliance anyway)? | Converter PM + Compliance | Phase C1 |
| 6 | Transaction description encryption (C5): does the UI need per-page materialize calls (paginated 25 txns at a time), or one bulk per statement? Latency implications. | Converter lead | Phase C5 |
| 7 | Phase 33 in the Converter's roadmap adds raw-memo storage (separate from cleansed-name). Same encryption posture as description? | Converter PM | Phase C5 |
| 8 | The `intuOrg` value (bank name) — operator-input but public information. Encrypt anyway for posture consistency, or leave cleartext for query simplicity? | Compliance | Phase C3 |

---

## Cross-references

- **Shield BUILD_PLAN.md §1** — compliance objectives.
- **Shield `apps/gateway/src/policy/built-in.ts`** — `cpa-converter-output` policy definition.
- **Shield `apps/gateway/src/routes/materialize.ts`** — the materialize endpoint.
- **Shield `packages/schema/src/vault/token-vault.ts`** — vault read/write API.
- **Shield `compliance/integrations/README.md`** — common patterns.
- **Converter `packages/extractor/src/llm-client.ts:540–552`** — base URL config (already honors `ANTHROPIC_BASE_URL`).
- **Converter `packages/extractor/src/llm-client.ts:680–742`** — the `extract()` entry.
- **Converter `apps/api/src/routes/uploads.ts:70`** — upload handler (open Shield session here).
- **Converter `apps/api/src/services/exports.ts:118–173`** — OFX assembly (materialize call here).
- **Converter `packages/exporters/src/ofx/xml-writer.ts:36–120`** — OFX XML writer (sees materialized cleartext).
- **Converter `.appliance/manifest.json` aka `vibe-app.yaml`** — env-var surface.
- **MyBooks integration plan** — comparison: MyBooks has no materialize path; Converter is the canonical case for it.
