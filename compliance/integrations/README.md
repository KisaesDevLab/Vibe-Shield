# Vibe Shield — per-app integration plans

These plans are the **contract** between Vibe Shield (the egress gateway) and each consuming Vibe app. Each app team uses its plan as the foundation for their own internal build plan; the plan does not stipulate timeline, only the surfaces that must change and the acceptance criteria those changes must meet.

Authority precedence (highest first):
1. Vibe Shield `BUILD_PLAN.md` §1 — the six compliance objectives that any integration must satisfy.
2. `CLAUDE.md` hard rules — the six things that must never happen.
3. This plan (the per-app integration).
4. The app team's internal build plan derived from this.

If a plan and a hard rule conflict, the hard rule wins. If you hit that conflict, file an issue against Vibe-Shield, not against the app.

## What each plan looks like

Every plan in this directory uses the same nine-section structure modeled on Shield's own `BUILD_PLAN.md`:

| § | Section | Purpose |
|---|---|---|
| 1 | Mission | One paragraph: what this integration achieves for this app |
| 2 | PII surface inventory | Concrete fields + data flows that carry PII through this app |
| 3 | Current Anthropic touchpoints | Every `@anthropic-ai/sdk` import / raw-fetch call with file:line |
| 4 | Architecture decisions | The handful of design choices that are specific to this app |
| 5 | Phased implementation | Phase-by-phase work with explicit acceptance criteria |
| 6 | Hard rules for this integration | App-specific extensions of the five global hard rules |
| 7 | Test plan | Recall/precision verification + integration tests + rollout gates |
| 8 | Rollout | Feature flag → canary → general availability |
| 9 | Open questions | Items the app team needs to resolve before kickoff |

## The four plans

| Plan | App | Distinguishing characteristic |
|---|---|---|
| [`vibe-mybooks.md`](./vibe-mybooks.md) | Vibe MyBooks | Standard text + image redaction across 4 AI services; default policy is `cpa-bookkeeping-balanced` (no materialize) |
| [`vibe-tb.md`](./vibe-tb.md) | Vibe Trial Balance | Already has manual account-number masking before LLM call (defense in depth becomes the win); same policy as MyBooks |
| [`vibe-tax-research.md`](./vibe-tax-research.md) | Vibe Tax Research Chat | Heavy streaming SSE + Anthropic built-in tools (code_execution / web_fetch / web_search) + custom skills — most complex integration |
| [`vibe-tx-converter.md`](./vibe-tx-converter.md) | Vibe Transactions Converter | Unique materialize-on-output pattern with `cpa-converter-output` policy; account number is operator-input (never extracted from PDF) and MUST appear in OFX/QFX/QBO output by spec |

## Plans NOT in this set (and why)

| App | Reason |
|---|---|
| Vibe Calculators | Light AI use (Phase 23 loan-agreement extraction). Single-touchpoint integration; can follow the MyBooks pattern. |
| Vibe Connect | Messaging + client portal. Once `Vibe Connect → Anthropic` integration solidifies, will follow Tax Research's streaming pattern. |
| Vibe Payroll Time | AI use scope still under design (anomaly detection). Follow MyBooks pattern when the spec lands. |
| Vibe GLM-OCR | Upstream of other apps; produces text that Tax Research / TX Converter / MyBooks consume. Not an Anthropic caller itself. |

If any of these grow Anthropic touchpoints, write a plan in this directory before the integration ships.

## Common patterns reused across plans

The four plans deliberately repeat themselves where the work is identical. Common patterns include:

- **SDK swap**: replace `import Anthropic from '@anthropic-ai/sdk'` with `import VibeShield from '@kisaesdevlab/vibe-shield-client'` at the single client-construction point. Shield client is API-compatible with the Anthropic SDK shape, so call sites don't change.
- **Base URL**: every app gets a new env var `ANTHROPIC_BASE_URL` (or app-specific equivalent) defaulting to `http://vibe-shield-gateway:8080`. On the Vibe Appliance this is set automatically by the Shield app overlay; in standalone deployments the operator points it at the Shield gateway.
- **Tenant API key**: each app gets an issued `vs_live_*` key via Shield's admin UI. The app's existing `ANTHROPIC_API_KEY` env var is repurposed to hold this. The real Anthropic key never leaves the appliance — only Shield holds it.
- **Session lifecycle**: each "interaction" (a chat thread, a statement-conversion job, a bookkeeping period) opens a Shield session. Same-session token allocation is stable across requests so re-id continuity works.
- **Fail-closed**: if Shield is unreachable, the AI feature reports an error to the user. There is no fallback to direct Anthropic.

## Hard-rule alignment

Every plan inherits the six Shield hard rules and adds app-specific elaboration:

1. **No cleartext PII in this app's logs, audit, error messages, or outbound Anthropic payloads.** Apps are responsible for their own log hygiene; Shield only handles redaction at the egress boundary.
2. **Only path to Anthropic is through Shield.** Every plan explicitly bans direct `@anthropic-ai/sdk` instantiation outside the single Shield-wrapping client.
3. **Fail-closed.** Apps must surface Shield unavailability as a 5xx to the user, not a fallback path.
4. **Recall + precision regression-tested.** Each app contributes synthetic fixtures to `qa/corpus/` reflecting its specific document shapes (bank statements for MyBooks, GL exports for TB, tax research queries for the chat app, statement PDFs for TX Converter).
5. **Recognizer changes documented.** If an app's PII shape forces a new recognizer or backstop, the change updates `compliance/recognizers.md` in this repo.
6. **Real client data never enters this repo OR the consuming app's repo.** Synthetic fixtures only — names/SSNs/EINs in valid-format-but-not-issued ranges via Faker. Same rule that gates `qa/corpus/real/` in Shield applies to each app's own test corpus.

## Update cadence

These plans are living documents. Each app team should send a PR against this directory whenever:

- A new AI feature lands that introduces a new PII surface
- The app's Anthropic touchpoint shape changes (e.g., switches from `messages.create` to `messages.stream`)
- The app's `.appliance/manifest.json` changes the env-var surface
- A new policy or backstop is required to handle the app's specific document shapes

Drift between an app's running code and this plan is itself a compliance defect.
