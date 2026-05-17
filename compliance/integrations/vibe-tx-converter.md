# Vibe Transactions Converter → Vibe Shield integration plan

**Target app:** [Vibe-Transaction-Convertor](https://github.com/KisaesDevLab/Vibe-Transaction-Convertor)
**Repo path (local):** `C:\Users\kwkcp\Projects\Vibe-Transaction-Convertor`
**Shield version this plan targets:** `v1.1.5+` (`cpa-converter-output` policy + `/v1/sessions/:id/materialize` endpoint, both confirmed present in `apps/gateway/src/policy/built-in.ts` and `apps/gateway/src/routes/materialize.ts`)
**Plan version:** 1.0 (initial)

---

## § 1. Mission

The Converter is **the only Vibe app where the goal is NOT to keep PII away from the customer**. The whole point of OFX/QFX/QBO export is to write the original account number into `<ACCTID>` so QuickBooks / Quicken / Xero can re-import the bank statement. The Converter inverts the standard Shield policy: tokenize on the way IN (to the LLM extractor); materialize on the way OUT (to the file the user downloads).

The architecture has a quirk that makes this easier than it looks: **the account number is never extracted from the PDF by the LLM**. It is **operator-input** when the account record is created; it lives in `accounts.accountNumber` (Postgres); and it is only re-introduced at OFX render time. The LLM sees only the masked `last-4` form from the statement header.

So the integration is in two halves:

1. **LLM side** (smaller): replace the vendored raw-fetch Anthropic provider with the Shield client. Apply the `cpa-converter-output` policy + per-conversion session. Tokenize the things the LLM sees: bank name, statement period dates (whitelist), transaction descriptions, masked-last-4 (already non-PII). Most of the LLM input is amounts + dates + already-masked digits — low PII surface compared to MyBooks.

2. **Export side** (the unique part): when the user clicks "Export to OFX," the route loads two distinct kinds of payload — (a) the operator-input `accounts.accountNumberEncrypted` (decrypted in-process with the Converter's own AES-256-GCM key per §4.2) and (b) the tokenized `transactions.description/name/memo` columns. The OFX writer assembles a JSON payload combining both, calls `Shield POST /v1/sessions/<id>/materialize` (which resolves any `<PERSON_n>` / `<US_BANK_ACCOUNT_n>` tokens in the payload via the session's vault), receives the materialized cleartext, and writes the result into the OFX/QFX/QBO XML.

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
| `transactions.description`, `name`, `memo` | Cleartext today | These come from OCR + LLM cleansing. Storage decision: persist tokens (`<PERSON_n>` etc.) populated by `/v1/messages` redaction; materialize via Shield at UI render and export. See §4.3. |
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

### 4.2 Storage decision: account numbers use the Converter's own per-tenant DEK

`accounts.accountNumber` + `accounts.routingNumber` are operator-input. They never pass through the LLM and never need redaction — Claude doesn't see them. Therefore Shield's vault is the wrong layer to store them in (Shield's vault is populated as a side-effect of redacting LLM payloads; there is **no** direct vault-write API in v1.1.x, and adding one is out of scope for this integration).

Use the same crypto pattern as Vibe-MyBooks' `PLAID_ENCRYPTION_KEY` and Vibe-Tax-Research's `MASTER_KEY`:

- The Converter's `accounts` schema gets two new columns: `accountNumberEncrypted` (bytea), `routingNumberEncrypted` (bytea). The old `accountNumber`, `routingNumber` columns are deprecated.
- The Converter generates one `CONVERTER_ACCOUNT_ENCRYPTION_KEY` per appliance (32 raw bytes base64, preserved across re-renders via the same `_extract_env_value` pattern the appliance uses for VS_KEK / intake_key — file a Vibe-Appliance PR to add it to `env-templates/per-app/vibe-tx-converter.env.tmpl`).
- AES-256-GCM, per-row IV, encryption library = the existing crypto helper the Converter uses for any other at-rest secret.
- During migration: a one-time backfill encrypts existing cleartext rows, then drops the old columns.

**Why not Shield's vault for these:** Shield's vault stores tokens that came out of recognizer-driven redaction. Account numbers are never tokenized (they never reach `/v1/messages`); they have no `<US_BANK_ACCOUNT_n>` token to resolve. Pushing them through Shield would require either (a) a new `POST /v1/sessions/:id/vault` endpoint to write arbitrary ciphertext (new Shield work, defers Converter integration) or (b) a synthetic `/v1/messages` call whose only purpose is to populate the vault (an ugly anti-pattern). The per-tenant-DEK approach is the same posture every other Vibe app uses for app-private secrets — no novel crypto, no new Shield endpoints.

### 4.3 Transaction descriptions: tokens from `/v1/messages` redaction, materialized at export

`transactions.description`, `transactions.name`, `transactions.memo` come from OCR + LLM-cleansing — they DO pass through `/v1/messages`, so Shield's recognizer pipeline tokenizes them as a side-effect of that call. The Converter then has two choices for how to persist:

**Option B (the right choice for the Converter): Store the tokens; materialize at export.**

- The Converter's LLM cleansing call to `/v1/messages` returns the cleansed text with `<PERSON_n>` / `<US_BANK_ACCOUNT_n>` etc. tokens already in place (and Shield's vault has the cleartext for each one, scoped to the conversion session).
- Persist the **tokenized** string in the description columns. No cleartext PII in the Converter's at-rest data.
- On UI render: call `Shield POST /v1/sessions/:id/materialize` to resolve tokens for the operator's view. (Materialize is policy-gated to `cpa-converter-output` per §4.5; the Converter's UI request uses the same vs_live key + session as the export path, so the gate passes.)
- On export: same `/v1/sessions/:id/materialize` call against the OFX payload before writing the file.

**Option A (do not adopt): Encrypt at rest via the Converter's own DEK.**

- Would require the Converter to receive cleartext from Shield (using the `policy_name='cpa-converter-output'` re-id path or a special-case override) and immediately re-encrypt with its own key. Two layers of crypto, no security gain, and the cleartext exists in process memory longer than necessary. Skip.

**Why Option B is the right inversion of the standard pattern:** every other Vibe app uses `cpa-bookkeeping-balanced` with `reid.mode='full'` — they want re-identified cleartext in their UI render. The Converter explicitly wants the opposite: cleartext NEVER appears anywhere in the Converter's database, and the materialize event is the single audited cleartext-emission point. That's exactly what `cpa-converter-output` (`reid.mode='none'`) plus the materialize endpoint deliver.

**Session-DEK lifetime is the gotcha.** The vault rows live only as long as the session does. If the conversion session is deleted (DELETE /v1/sessions/:id) before export, the tokens become permanently unresolvable. The Converter MUST hold the conversion session open from upload through export-and-download. See §4.4 lifecycle for the timing.

### 4.4 Session lifecycle: per-conversion (per-statement)

A "conversion" is one PDF upload → one OFX/CSV/QBO/QFX output. The Shield session lifecycle maps to that:

- **Open** session at upload (`POST /api/uploads/:accountId` in `uploads.ts:70`) with `policy_name='cpa-converter-output'`. Session ID stored on the `statements` row.
- **Use** session ID on every LLM extraction call (the recognizer pipeline tokenizes the markdown; the tokens are deterministic within the session and the vault holds the cleartext for each one).
- **Use** session ID for every UI render of transactions (materialize tokenized descriptions for operator display).
- **Use** session ID at export (materialize tokenized payload for the OFX file).
- **Delete** session via `DELETE /v1/sessions/:id` after the user downloads the export AND a configurable retention window expires (default 30 days, matching the existing maintenance worker's PDF retention). Early deletion makes tokens permanently unresolvable — the description columns stay readable as tokens but can no longer be materialized.

Multi-statement batches: each statement gets its own session. The user's "import 30 statements at once" flow opens 30 sessions in parallel.

**Hard constraint:** the session must not be deleted between upload and final export. If retention policy + user behaviour conflict (e.g., the user comes back on day 31 to re-export), the only recovery is re-OCR + re-extract from the original PDF — which is acceptable for the Converter because the PDF is the source of truth.

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
- [ ] Tenant API key issued for `tenantId: tx-converter-prod`, `appId: converter` (must match `CONVERTER_OUTPUT.allowed_apps` in Shield's `built-in.ts`).
- [ ] Verify `cpa-converter-output` policy is in the response of `GET /v1/admin/policies`. If missing on the running gateway, the operator is pinned to an older Shield image — upgrade to v1.1.5+ before Converter kickoff.
- [ ] Verify `cpa-converter-output` shows `reid.mode = 'none'` and `allowed_apps = ['converter']` in that response. (The materialize gate is enforced in `apps/gateway/src/routes/materialize.ts` by matching the active policy NAME against `CONVERTER_OUTPUT.name`; there is no separate `materialize: true` boolean on the policy.)

**Acceptance:** `curl -X POST -H "Authorization: Bearer vs_live_..." -H "content-type: application/json" -d '{"payload":{}}' http://vibe-shield-gateway:8080/v1/sessions/<real-uuid>/materialize` against a session opened under `cpa-converter-output` returns 200 with `materialized: {}`. Against a session opened under `cpa-bookkeeping-balanced`, the same call returns 403 `materialize requires policy "cpa-converter-output"`.

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

### Phase C3 — Half B: encrypt account PII with the Converter's own per-tenant DEK

- [ ] Generate `CONVERTER_ACCOUNT_ENCRYPTION_KEY` (32 raw bytes base64). Add it to `.appliance/manifest.json` env block as a `generated:base64-32bytes` field. File a paired Vibe-Appliance PR adding `@CONVERTER_ACCOUNT_ENCRYPTION_KEY@` substitution + preservation across re-renders (same `_extract_env_value` pattern that VS_KEK uses today in `lib/enable-app.sh:797–807`).
- [ ] Migrate `accounts` table:
  - Add `accountNumberEncrypted` (bytea), `routingNumberEncrypted` (bytea), each with a per-row 12-byte GCM IV column.
  - Crypto helper: AES-256-GCM using `CONVERTER_ACCOUNT_ENCRYPTION_KEY` (same library the Converter uses for any other at-rest secret).
  - On account create / update: encrypt cleartext, store ciphertext + IV. Cleartext never persisted.
  - Backfill existing rows: encrypt each cleartext value in-place during the deploy migration, then drop the cleartext columns.
- [ ] **CRITICAL:** backfill runs as an atomic migration; the Converter accepts no account writes during it. Operators follow the runbook (the maintenance worker is paused, the API returns 503 on `POST /api/accounts`).
- [ ] After backfill, drop the cleartext `accountNumber`, `routingNumber` columns in the next release (keep one release of read-only fallback for rollback safety, then drop).

**Acceptance:** A new account creation results in cleartext NEVER hitting Postgres in cleartext form (verify by checking `pg_dump` output for the test fixture's account number string). The account number round-trips: write → encrypt → store → load → decrypt → use in OFX. The Converter container has access to `CONVERTER_ACCOUNT_ENCRYPTION_KEY` but Shield's gateway/admin/engine containers do NOT (key scoped to converter only via the per-app env file).

### Phase C4 — Half B: materialize at export

- [ ] In `exports.ts:118–173` (the OFX assembly), assemble a JSON payload that mixes (a) the operator-input account/routing numbers (decrypted in-process via the Converter's own DEK per §4.2) with (b) the tokenized transaction descriptions (loaded as-stored from `transactions.description/name/memo`):
  ```ts
  // Decrypt operator-input fields with the Converter's own key.
  const accountId = converterCrypto.decrypt(account.accountNumberEncrypted, account.accountNumberIv);
  const bankId    = converterCrypto.decrypt(account.routingNumberEncrypted, account.routingNumberIv);

  // Build the OFX payload as JSON, leaving tokens in the description fields.
  const ofxPayload = buildOfxJson({ accountId, bankId, transactions });

  // One Shield materialize call resolves every <PERSON_n> / <US_BANK_ACCOUNT_n>
  // token in the payload. Operator-input cleartext (accountId, bankId) is
  // already cleartext and passes through unchanged.
  const { materialized, output_hash } = await shield.post(
    `/v1/sessions/${statement.shieldSessionId}/materialize`,
    { payload: ofxPayload, output_filename: `${statement.id}.ofx` },
  );

  // Serialize materialized JSON to XML.
  const ofxXml = xmlWriter.write(materialized);
  ```
- [ ] The XML writer (`xml-writer.ts:36–120`) sees the materialized cleartext exactly once, writes it to the buffer, and returns. Cleartext is held in memory only for the duration of one HTTP response.
- [ ] **Never log the materialized values.** Shield's audit captures the materialize event with `output_hash` (SHA-256 of the serialized output) — that's the auditable record, not the values.

**Acceptance:** Download an OFX file for a statement; verify `<ACCTID>` and `<BANKID>` contain the operator-input cleartext numbers; verify `<NAME>` and `<MEMO>` contain re-identified transaction descriptions. Verify the Converter's logs for the same request show no cleartext PII. Verify Shield's audit log shows one `materialize` event with `output_hash` populated and a row in `vs_audit` whose `payload_hash` matches `sha256(serialized output)`.

### Phase C5 — Transaction-description tokenization (Option B from §4.3)

- [ ] Persist the **tokenized** output of the `/v1/messages` cleansing call directly into `transactions.description`, `name`, `memo`. No additional encryption layer — tokens are already opaque, and Shield's vault holds the cleartext keyed by the conversion session.
- [ ] On UI render of a statement detail page: bundle every tokenized description into a single JSON array, call `POST /v1/sessions/<statement.shieldSessionId>/materialize` once per page render (not per row), and render the materialized cleartext. Cache materialized values in the request-scoped React Query cache; never write them to localStorage or the Converter's DB.
- [ ] On OFX export: the same materialize call (§C4) resolves description tokens in the same payload pass as the account-field substitutions.
- [ ] Backfill existing rows: for each transaction, open a one-time Shield session under `cpa-converter-output`, send the cleartext through `/v1/messages` with a no-op prompt that triggers the recognizer pipeline, persist the tokenized form, drop cleartext columns. Same runbook posture as C3 (paused writes during backfill).

**Acceptance:** Statement detail page renders re-identified descriptions to the operator. `pg_dump transactions` shows tokenized strings only (`grep -E '<PERSON_|<US_BANK_ACCOUNT_'` matches; `grep` for the test fixture's cleartext name returns zero). OFX export produces the same `<NAME>` and `<MEMO>` values as the pre-Shield code did.

### Phase C6 — Session deletion + retention

- [ ] When the user explicitly deletes a statement, call `Shield DELETE /v1/sessions/<statement.shieldSessionId>` (idempotent — second DELETE still returns 204).
- [ ] Maintenance worker (`maintenance.worker.ts`) gains a "delete old shield sessions" sweep: any statement older than 30 days that's been exported AND the user has downloaded the file → DELETE the session. The tokenized columns remain in the Converter's DB (they're already opaque) but can no longer be materialized.
- [ ] Document the retention policy explicitly. The cleartext-resolve window is bounded; after deletion the tokens are permanently unresolvable. Recovery path: re-OCR the original PDF.

**Acceptance:** After DELETE, attempting `POST /v1/sessions/<id>/materialize` on the session's tokens returns 404 "session not found". The statement's Converter-side audit row shows the deletion event with timestamp.

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
| 1 | Confirmed: `cpa-converter-output` ships in Shield's `apps/gateway/src/policy/built-in.ts` today; no C0 work needed. | Shield owner | (resolved) |
| 2 | Confirmed: `POST /v1/sessions/:id/materialize` exists (`apps/gateway/src/routes/materialize.ts:54`) and is policy-gated to `cpa-converter-output`. There is NO `/v1/sessions/:id/tokenize` endpoint — Phase C3 uses the Converter's own per-tenant DEK for operator-input fields instead (§4.2). | Shield owner | (resolved) |
| 3 | Backfill (C3 + C5): one-shot during a maintenance window, or rolling? Rolling needs dual-read logic during the migration. | Converter lead | Phase C3 |
| 4 | If the operator types a 12-digit account number in the UI but the bank statement OCR shows a different number (typo / wrong account picked), does the export silently materialize the operator-input value, or warn? | Converter PM | Phase C4 |
| 5 | The local Vibe LLM Gateway (Qwen3-8B) — same prompt redaction posture if firms opt for local LLM? Or does local LLM see cleartext (since it never leaves the appliance anyway)? | Converter PM + Compliance | Phase C1 |
| 6 | Transaction description encryption (C5): does the UI need per-page materialize calls (paginated 25 txns at a time), or one bulk per statement? Latency implications. | Converter lead | Phase C5 |
| 7 | Phase 33 in the Converter's roadmap adds raw-memo storage (separate from cleansed-name). Same encryption posture as description? | Converter PM | Phase C5 |
| 8 | The `intuOrg` value (bank name) — operator-input but public information. Encrypt anyway for posture consistency, or leave cleartext for query simplicity? | Compliance | Phase C3 |
| 9 | Vibe-Appliance PR to add `@CONVERTER_ACCOUNT_ENCRYPTION_KEY@` substitution + preservation in `lib/enable-app.sh` and `env-templates/per-app/vibe-tx-converter.env.tmpl`. Same pattern as VS_KEK (`enable-app.sh:797–807`). | Appliance owner + Converter lead | Phase C3 |

---

## Cross-references

- **Shield BUILD_PLAN.md §1** — compliance objectives.
- **Shield `apps/gateway/src/policy/built-in.ts`** — `cpa-converter-output` policy definition.
- **Shield `apps/gateway/src/routes/materialize.ts`** — the materialize endpoint.
- **Shield `packages/schema/src/vault/token-vault.ts`** — vault read API (internal — populated as a side-effect of `/v1/messages` redaction; no direct external write).
- **Shield `compliance/integrations/README.md`** — common patterns.
- **Converter `packages/extractor/src/llm-client.ts:540–552`** — base URL config (already honors `ANTHROPIC_BASE_URL`).
- **Converter `packages/extractor/src/llm-client.ts:680–742`** — the `extract()` entry.
- **Converter `apps/api/src/routes/uploads.ts:70`** — upload handler (open Shield session here).
- **Converter `apps/api/src/services/exports.ts:118–173`** — OFX assembly (materialize call here).
- **Converter `packages/exporters/src/ofx/xml-writer.ts:36–120`** — OFX XML writer (sees materialized cleartext).
- **Converter `.appliance/manifest.json` aka `vibe-app.yaml`** — env-var surface.
- **MyBooks integration plan** — comparison: MyBooks has no materialize path; Converter is the canonical case for it.
