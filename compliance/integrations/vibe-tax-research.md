# Vibe Tax Research Chat → Vibe Shield integration plan

**Target app:** [Vibe-Tax-Research-Chat](https://github.com/KisaesDevLab/Vibe-Tax-Research-Chat)
**Repo path (local):** `C:\Users\kwkcp\Projects\Vibe-Tax-Research-Chat`
**Shield version this plan targets:** `v1.1.4+` (SSE streaming, recursive JSON tool-input redaction, session reuse)
**Plan version:** 1.0 (initial)

---

## § 1. Mission

Vibe Tax Research Chat is the most complex Shield integration in the suite. It streams Claude responses via SSE; it uses Anthropic's built-in tools (`code_execution`, `web_fetch`, `web_search`); it supports custom firm-uploaded **skills** (uploaded as multipart, bypassing the SDK); it persists every assistant turn (full text + citations + compliance checklist) to Postgres; it bundles 180 KB of attachment context into every prompt; and it logs detailed consultations (web_fetch URL + response excerpt, web_search query + result).

Every one of those surfaces touches PII. The integration:

1. Replaces the per-request Anthropic SDK construction with a Shield-fronted client.
2. Wraps the streaming consumer so every `text_delta`, `tool_use.input`, and `tool_result.result` passes through redaction before reaching the SSE write OR the database.
3. Routes the skills-upload `fetch()` through Shield's gateway as well (so even the multipart skill files are scanned).
4. Pins the `tax-research` policy on every request.
5. Preserves Anthropic's original token counts for cost calculation (Shield's redaction MUST NOT corrupt the cost model).

The hard part is point 2. Shield already ships SSE buffering with token-boundary preservation and a recursive JSON walk for `tool_use.input` (per `apps/gateway/src/proxy/streaming.ts` + `redactor.ts`). The TB integration only used the non-stream path; Tax Research is the first consumer to exercise the streaming + tool-use surface end-to-end.

Policy: `tax-research`. Allows re-id on response. No materialize (citations are public; the firm-internal client identifiers should stay tokenized in any stored response).

---

## § 2. PII surface inventory

### 2.1 The five highest-risk surfaces

| Surface | Storage | Risk | Notes |
|---|---|---|---|
| Chat user prompts | `messages.content` | High | Free-form; may contain client SSN/EIN/DOB/account, file paths, internal memos |
| Attachment full_text | `chat_attachments.full_text` | Highest | 180 KB cap per chat; OCR'd PDFs of firm memos, court rulings (sometimes with sealed-party names), client documents |
| Assistant response text | `messages.content` | High | Claude's reply re-states client identifiers; the entire response is persisted |
| Tool inputs (`tool_use.input`) | `primary_source_consultations` | Medium-high | `web_fetch` URL params + headers; `web_search` query text; custom-skill input JSON (app-defined shape) |
| Tool results (`tool_result.result`) | `primary_source_consultations.response_excerpt` (2KB) | Medium | Fetched web content excerpt; search results; custom-skill outputs |

### 2.2 Tool-use specifics

Tools are NOT explicit function definitions in this app — they're Anthropic's built-ins + uploaded custom skills:

| Tool | Type | What it sees | Where its result lives |
|---|---|---|---|
| `code_execution` | `code_execution_20250825` | Auto-injected; sandboxed | Result back in stream as `tool_result` |
| `web_fetch` | `web_fetch_20260209` | URL the model wants to read (with allowlist filter) | URL + domain + 2KB excerpt → `primary_source_consultations` |
| `web_search` | `web_search_20260209` | Search query text | Query + results → `primary_source_consultations` |
| Custom skills | `custom` (uploaded via `/v1/skills`) | App-defined input JSON | Skill output back in stream as `tool_result` |

### 2.3 Skills upload bypass

`apps/api/src/lib/anthropic/skills.ts:112` uses a raw `fetch()` (not the SDK) because SDK v0.40.1 has no typed `skills` resource. Multipart form: per-skill files + shared rule files + the Anthropic API key in the `x-api-key` header. This bypass MUST be re-routed through Shield (Phase TR3).

### 2.4 What does NOT need Shield

- `MODELS_MANIFEST_URL` fetch (manifest of available models from `vibemb.com`) — public data, no PII.
- JWT auth flow — no Anthropic involvement.
- Heartbeat / SSE keepalive — text-only.

---

## § 3. Current Anthropic touchpoints

### 3.1 Three files; three different patterns

| File | Lines | Pattern | Notes |
|---|---|---|---|
| `apps/api/src/lib/anthropic/client.ts` | 9, 27, 34 | `new Anthropic({ apiKey })` per request | Validation pings via non-streamed `messages.create` |
| `apps/api/src/lib/anthropic/chat.ts` | 197, 319 | `client.beta.messages.stream(body)` — async-iterable | **Streaming** + tools + skills + extended-cache betas |
| `apps/api/src/lib/anthropic/skills.ts` | 112, 115 | Raw `fetch(SKILLS_ENDPOINT, { headers: { 'x-api-key': key }, body: fd })` | Multipart, SDK-bypass |

### 3.2 Stream events the consumer must handle

`apps/api/src/routes/chats/messages.ts:319–519` consumes the stream. The consumer maps:

| Stream event | Goes to | Goes to DB |
|---|---|---|
| `text_delta` | SSE `text` event → browser | Accumulated into `assistantText`, persisted in `messages.content` |
| `tool_use` (input assembled from `input_json_delta` chunks) | SSE `tool_use` event | Logged to consultations |
| `tool_result` | SSE `tool_result` event | Result excerpt to consultations.response_excerpt |
| `usage` | SSE `usage` event | Cost calc (must use pre-redaction token counts) |
| `message_stop` | SSE `done` event + commit | Authorities + compliance JSON parsed and stored |

### 3.3 Cost calculation

`apps/api/src/routes/chats/messages.ts:408–430` derives cost from `usage.input_tokens` + `usage.output_tokens`. **These counts MUST be the original Anthropic counts, not the post-Shield-redaction counts.** Shield's gateway passes through Anthropic's `usage` block unchanged (per spec); the cost calc is unaffected.

### 3.4 API key handling

Encrypted in `settings` table; decrypted in-memory per request via `getAnthropic()`. SHA-256 fingerprint logged (first 16 chars only). The cleartext key is never logged. Post-Shield, the value stored in `settings.ANTHROPIC_API_KEY` becomes a `vs_live_*` Shield key; the real Anthropic key never enters this app's process memory.

---

## § 4. Architecture decisions

### 4.1 The streaming consumer is where Shield does its work

Shield's existing SSE pipeline (`apps/gateway/src/proxy/streaming.ts`) already does:
- Token-boundary buffering (holds `<` until matching `>` arrives so a token straddling two `text_delta` events isn't half-resolved).
- Re-id on each delta.
- Pass-through for non-text events (`message_start`, `content_block_start`, etc.).

Tax Research is the first consumer to exercise this in production. The integration must verify that this app's specific event mix (text + tool_use + tool_result + usage + message_stop + skill outputs) round-trips cleanly.

### 4.2 Tool-input redaction uses Shield's recursive JSON walk

When the chat assembles a `tool_use` event (after the `content_block_stop` chunk parses the accumulated JSON at `chat.ts:232`), the `input` object goes through Shield's recursive `RedactedRequest.redactJson()` (in `apps/gateway/src/proxy/redactor.ts`). This handles:
- `web_fetch.url` query-string params with PII
- `web_search.query` containing client identifiers
- Arbitrary custom-skill JSON shapes

The chat consumer doesn't have to know the tool's input schema; Shield walks the whole structure.

### 4.3 Tool-result redaction happens server-side at the gateway

`tool_result.result` comes back FROM Anthropic with the tool's output (e.g., the fetched web page content). Even though the gateway can't predict what the tool returned, the same recursive-JSON walk applies on the gateway → client path. Recognizers find any PII in the fetched content (e.g., if `web_fetch` accidentally read a public page that contained a client name).

### 4.4 Skills-upload is the third Anthropic surface

The skills upload (`skills.ts:112`) is a raw `fetch()`, not an SDK call. Shield needs a `/v1/skills` proxy route that accepts multipart, scans every file's contents for PII (using engine `/redact-text` and `/redact-image` paths), and forwards the cleaned files to Anthropic. This is new work in Shield itself (see Phase TR3 open items).

For v1, an acceptable shortcut: a firm policy says "skills uploaded by firm admins are pre-vetted; Shield audits the upload but does not redact." This matches how operator-uploaded firm memos are already trusted (the `entityContext` parallel from MyBooks).

### 4.5 Session lifecycle = one Shield session per chat conversation

A chat conversation may span many messages over hours/days. Use the conversation ID as the Shield session ID so tokens stay stable: turn 17 mentioning "Hector Diaz" produces the same `<PERSON_5>` token as turn 1.

When a conversation is archived or deleted, call `Shield POST /v1/sessions/<id>/purge`.

### 4.6 Cost calc is sacred

Shield's audit captures token counts but the gateway response passes Anthropic's `usage` block through unchanged. Tax Research's existing cost calc (`messages.ts:408–430`) works without modification. **The plan's hard rule: any change to Shield's pass-through of `usage` is a P0 regression for Tax Research.**

### 4.7 Stream-batching tradeoff

Shield's SSE buffer holds bytes from `<` to `>`. Worst case: a Claude reply produces a single large `<US_BANK_ACCOUNT_99999>` token (extreme — would never happen). Token names are bounded (max ~30 chars). The buffer's worst-case latency penalty is sub-millisecond.

However: Tax Research's current per-delta `res.flush()` (chat consumer `messages.ts:228–232`) emits every byte the moment it arrives. With Shield in front, the buffer may delay individual bytes by up to one full token width. The chat UI's user-perceived smoothness should be unchanged in practice; pin this with a streaming latency test (Phase TR4).

### 4.8 Policy: `tax-research`

- Allows re-id on response (cleartext shown to the researcher).
- Does NOT allow materialize (citations are public; never reconstruct cleartext outside the response path).
- Stricter recognizers: enables the `sealed_party` recognizer (a recognizer for redacted court-document party names like "Doe v. Smith" where Smith is sealed).

The `tax-research` policy is defined in Shield's `apps/gateway/src/policy/built-in.ts`. Confirm it exists before kickoff.

---

## § 5. Phased implementation

### Phase TR0 — Shield reachable + policy verified

- [ ] Vibe Appliance has Shield enabled.
- [ ] Tax Research operator can `curl http://vibe-shield-gateway:8080/health` from the api container.
- [ ] Issue a tenant API key for `tenantId: tax-research-prod`, `appId: tax-research`.
- [ ] Verify the `tax-research` policy exists in Shield (`GET /v1/admin/policies` from Shield admin UI). If missing, the Shield team adds it before Tax Research kickoff.

**Acceptance:** `curl -H "Authorization: Bearer vs_live_..." -H "Anthropic-Version: 2023-06-01"` to Shield returns a Shield envelope. `GET /v1/admin/policies` lists `tax-research`.

### Phase TR1 — SDK swap (non-stream first)

- [ ] Add `@kisaesdevlab/vibe-shield-client` to `apps/api/package.json`.
- [ ] Replace `import Anthropic` at `client.ts:9` with the Shield client.
- [ ] Replace `new Anthropic({ apiKey })` at `client.ts:27` with Shield client.
- [ ] Add `ANTHROPIC_BASE_URL` env var (zod). Default for appliance: `http://vibe-shield-gateway:8080`.
- [ ] Update `.appliance/manifest.json` env block.
- [ ] Verify the non-streamed validation ping path (`client.ts:34`) works. This is the easiest path; it's request/response only and has no tools.

**Acceptance:** A model-validation call against a running Shield instance returns a valid Anthropic-shaped response; Shield's audit shows the request body. Streaming + tools NOT yet touched.

### Phase TR2 — Streaming consumer

The hardest phase. The order matters because each step is independently testable.

- [ ] Verify the streaming construct works: `client.beta.messages.stream(body)` returns an async iterable through Shield's gateway. Shield's SSE proxy already handles `beta.messages.stream` — confirm.
- [ ] In the streaming consumer (`messages.ts:337–519`), attach the policy + session ID to every stream request body:
  ```ts
  const body = {
    model, max_tokens, system, messages, tools,
    policy_name: 'tax-research',
    session_id: conversationId,
    ...(betas ? { betas } : {}),
  };
  ```
- [ ] Verify each event type still arrives in order: `message_start`, `content_block_start`, `content_block_delta` × N, `content_block_stop`, ..., `message_stop`.
- [ ] Pin: a streamed response containing `<PERSON_3>` mid-delta gets the correct cleartext name in the user's UI (Shield's per-delta re-id).
- [ ] Pin: a `text_delta` that ends mid-token (e.g., emits `"...account is <PERSON"` then `_3>..."` in the next chunk) still resolves correctly thanks to Shield's `<`-buffer.

**Acceptance:** A live chat with a PII-bearing prompt streams smoothly; the assistant text in the browser shows cleartext; Shield's audit log for that turn shows the request had tokens only; `messages.content` in DB is re-identified cleartext (NOT raw tokens, NOT cleartext-that-bypassed-Shield).

### Phase TR3 — Tool-use redaction

- [ ] Tool inputs: when the stream consumer parses the assembled JSON at `chat.ts:232`, Shield's recursive redactor has ALREADY been applied at the gateway. The consumer receives the post-redaction `input`.
- [ ] Verify: send a prompt that prompts `web_fetch` against `https://example.com?account=234-56-7890`. Confirm Shield audit shows the URL with the SSN tokenized; confirm `primary_source_consultations.url` in DB has the cleartext URL re-identified.
- [ ] Tool results: same recursive walk on the gateway → client path. Verify Shield's audit + the persisted `response_excerpt`.
- [ ] **Custom skills uploaded via the multipart bypass**: route the `fetch()` at `skills.ts:112` through Shield. Two options:
  - (a) Wait for Shield to ship a `/v1/skills` proxy route (file a Shield issue; out of scope for the Tax Research team).
  - (b) Document a v1 firm policy: "Skills are admin-curated and trusted; Shield audits but doesn't redact." This matches MyBooks' `entityContext` trust posture for operator-curated content.

**Acceptance:** A turn that uses `web_fetch` with a PII-bearing URL is captured in Shield's audit as tokens; the user's chat UI shows the cleartext (re-id'd) URL; `primary_source_consultations` row has the re-id'd cleartext.

### Phase TR4 — Latency + buffering verification

- [ ] Run a streaming latency test: 100 chat turns through Shield vs direct Anthropic. Measure p50 / p95 / p99 time-to-first-byte and inter-delta latency.
- [ ] Acceptable threshold: p99 inter-delta latency post-Shield is within 25 ms of direct Anthropic. Anything worse means the `<`-buffer is holding back too long.

**Acceptance:** Latency report committed to the Shield repo at `qa/load/tax-research-streaming-latency.md`.

### Phase TR5 — Cost-calc preservation + persistence + audit

- [ ] Verify: `usage.input_tokens` + `usage.output_tokens` in Shield-fronted responses match what direct Anthropic returns for the same prompt (subject to redaction's modification of the input — fewer cleartext characters might mean fewer tokens, but Shield's gateway just passes through what Anthropic returns).
- [ ] Verify cost calc still works in `messages.ts:408–430`. **Do NOT compute cost from pre-redaction text length.**
- [ ] Persist redacted/re-id'd content correctly:
  - `messages.content` — re-id'd cleartext (the user's view of truth).
  - `primary_source_consultations.url`, `query`, `response_excerpt` — re-id'd cleartext.
  - **NEVER** persist raw `<PERSON_n>` tokens in the user-visible content.
- [ ] Audit: grep tax-research api logs + DB columns for cleartext PII used in tests.

**Acceptance:** Cost-calc spreadsheet from a 30-call run matches pre-Shield costs ±1%. Cleartext-leak audit returns zero matches in logs / DB.

### Phase TR6 — Fail-closed + skills-upload + GA

- [ ] When Shield is down, chat shows "AI is temporarily unavailable" and the SSE connection closes cleanly (don't hang).
- [ ] 429 backoff: honor Shield's `Retry-After` header on the chat-submit button.
- [ ] Skills upload: either (a) wait for Shield `/v1/skills` proxy, or (b) ship v1 with the documented trust policy and a TODO to add the proxy.
- [ ] Add an integration test that triggers `code_execution` and verifies the sandbox output doesn't leak PII (the sandbox is Anthropic's; this is a defense check that Claude doesn't echo cleartext through code output).

**Acceptance:** With Shield stopped, chat shows the expected error; no 500s. 429 backoff demonstrated. Code-execution PII echo absent.

---

## § 6. Hard rules for this integration

1. **`@anthropic-ai/sdk` import only in `client.ts`.** The skills.ts raw `fetch()` is the SDK bypass; route it through Shield in Phase TR3.

2. **Streaming consumer MUST consume from Shield's gateway, not from `client.beta.messages.stream` directly.** The Shield client wraps the SDK so this is automatic, but verify post-swap that the iterator is going through Shield.

3. **Cost calc uses ORIGINAL Anthropic token counts, NOT post-redaction lengths.** Any change to Shield's pass-through of `usage` is a P0 regression here.

4. **Tool-result content is logged with the SAME redaction posture as the response.** Don't accidentally make `primary_source_consultations.response_excerpt` a back-channel for cleartext that the chat response correctly redacted.

5. **Skills uploaded via the multipart bypass: either redact or trust-by-policy, but documented.** The trust-by-policy posture matches MyBooks' `entityContext` precedent; document it explicitly so an auditor can find the decision.

6. **No re-id of system prompt content.** The system prompt comes from the app, not from Anthropic; if it contains a token (it shouldn't), do not re-identify in the prompt context. (Shield re-identifies in RESPONSES, not in operator-controlled prompts.)

---

## § 7. Test plan

### 7.1 Integration suite (Tax Research → mock Shield)

- **Plain streaming**: 10-turn chat, no tools, PII in prompts. Verify each turn's request body in mock-Shield has tokens; each delta in the SSE response is re-identified cleartext.
- **Tool use — web_fetch**: prompt model to fetch a URL with PII in query string. Verify URL is tokenized in the outbound tool_use; verify the `primary_source_consultations.url` is re-id'd cleartext.
- **Tool use — web_search**: query with PII. Same checks.
- **Tool use — code_execution**: code that prints a synthetic SSN. Verify the `tool_result.result` text doesn't leak (this is a defense against Claude echoing PII via code output).
- **Custom skill**: upload a skill with a memo containing a fake EIN; verify Shield's audit covers it OR the trust-by-policy decision is logged.
- **Session reuse**: chat conversation mentioning the same client name across turns 1, 5, 17; verify identical `<PERSON_n>` token.
- **Cost calc**: 30 calls, compare cost against pre-Shield baseline. Must match within 1%.
- **Latency**: streaming TTFB + inter-delta latency, p50/p95/p99.

### 7.2 Recall/precision regression

Tax Research contributes to Shield's QA corpus:
- 10+ research-prompt fixtures with PII (real-style queries: "Calculate the QBI deduction for John Doe SSN 234-56-7890 with K-1 from Acme LLC EIN 12-3456789").
- 5+ web_fetch URL fixtures with PII in query strings.
- 3+ web_search query fixtures.

Shield's QA harness must continue passing the precision floor with these added.

### 7.3 Cleartext-leak audit

```bash
grep -rE 'Maria Reyes|234-56-7890|012345678|hector\.diaz' /var/log/tax-research/
psql vibe_tax_research_db -c "SELECT count(*) FROM messages WHERE content LIKE '%234-56-7890%';"  # should be re-id'd cleartext OR zero, never raw tokens
psql vibe_tax_research_db -c "SELECT count(*) FROM primary_source_consultations WHERE url LIKE '%token%' OR query LIKE '%token%';"  # zero raw tokens
psql vibe_tax_research_db -c "SELECT count(*) FROM chat_attachments WHERE full_text LIKE '%234-56-7890%';"  # zero, attachments stored pre-redaction OR not at all
```

Expected: zero raw token strings (`<PERSON_n>`) in any user-visible / persisted content; cleartext counts depend on what the test prompts contained (re-id'd output is fine).

---

## § 8. Rollout

### 8.1 Pre-rollout

- [ ] Phases TR0–TR6 complete on a feature branch.
- [ ] Latency test results committed.
- [ ] Cost calc parity verified.

### 8.2 Canary

- [ ] Enable `TAX_RESEARCH_USE_SHIELD=true` for one firm with operator consent.
- [ ] Monitor:
  - Shield's `vs_recognizer_misses` for tax-research-tenant rows.
  - Chat user-perceived latency (UI emits a `time_to_first_token_ms` metric).
  - Tool-use failure rate (Anthropic may reject malformed tool_use post-redaction if Shield over-redacts a tool_use_id).
- [ ] 14 days clean canary.

### 8.3 GA

- [ ] Default `TAX_RESEARCH_USE_SHIELD=true` on the appliance.
- [ ] Update installer to auto-issue the tax-research tenant key.

### 8.4 Bypass

Same shape as MyBooks (§8.4). Documented escape hatch, audit-logged, P0 incident if used.

---

## § 9. Open questions

| # | Question | Owner | Resolution before |
|---|---|---|---|
| 1 | Does Shield ship the `tax-research` policy by default, or do we add it as part of TR0? | Shield owner | Phase TR0 |
| 2 | Custom skills via multipart bypass: ship v1 with the trust-by-policy decision, or block on Shield's `/v1/skills` proxy? Recommend (a) for the v1 cut. | TR PM + Shield owner | Phase TR3 |
| 3 | Stream-batching latency: is +25 ms p99 the right threshold, or do we need tighter? Will depend on the firm's network path. | TR lead | Phase TR4 |
| 4 | The 180 KB attachment context cap — Shield's `MAX_REQUEST_BYTES` defaults to 1 MB. Confirm a 180 KB attachment + a 50 KB conversation history fits. | Shield ops | Phase TR2 |
| 5 | `chat_attachments.full_text` is the persisted OCR'd document text. Is THAT pre-redacted before storage, or kept as-is and only redacted at prompt-injection time? Pre-redact gives storage-side compliance; keep-as-is is cheaper. | TR lead | Phase TR5 |
| 6 | If a court ruling cites a sealed party, the public PDF has "[REDACTED]" in place of the name. Should Shield's `sealed_party` recognizer treat that as a PII signal (re-redact bracketed redactions in attachment text)? | Shield owner | Phase TR5 (QA corpus) |
| 7 | Anthropic's `extended-cache-ttl-2025-04-11` beta caches prompts for 1h. If Shield's session is purged before the cache expires, Anthropic still has a cached version of the (tokenized) prompt. Acceptable? | Compliance review | Phase TR2 |
| 8 | The MCP server (separate JWT auth, rate-limit 100/60s) — out of scope for this plan? Confirm. | TR lead | Phase TR0 |

---

## Cross-references

- **Shield BUILD_PLAN.md §1** — compliance objectives.
- **Shield `apps/gateway/src/proxy/streaming.ts`** — the SSE buffering implementation Tax Research exercises in production.
- **Shield `apps/gateway/src/proxy/redactor.ts`** — recursive JSON walk for tool inputs.
- **Shield `apps/gateway/src/policy/built-in.ts`** — `tax-research` policy definition.
- **Shield `compliance/integrations/README.md`** — common patterns.
- **TR `apps/api/src/lib/anthropic/client.ts:27`** — SDK constructor.
- **TR `apps/api/src/lib/anthropic/chat.ts:197`** — streaming entry.
- **TR `apps/api/src/lib/anthropic/skills.ts:112`** — multipart bypass.
- **TR `apps/api/src/routes/chats/messages.ts:337–519`** — the stream consumer.
- **MyBooks integration plan** — `entityContext` precedent for "operator-curated, trust-by-policy" content.
