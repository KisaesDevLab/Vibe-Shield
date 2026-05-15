# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mission

Vibe Shield is a self-hosted PII redaction gateway that sits between other Vibe apps and the Anthropic Claude API. It is the technical implementation of a CPA-firm compliance posture (AICPA ET §1.700, FTC Safeguards Rule, Anthropic DPA + ZDR). Read [BUILD_PLAN.md](./BUILD_PLAN.md) before touching code — it is the single source of truth for architecture, phased scope, and acceptance criteria.

> The compliance memo (`docs/compliance-memo.md` per the kickoff prompt) is referenced as context but is **not present in this repo yet**. Treat BUILD_PLAN.md §1 as the operative compliance summary until that memo is added.

## Hard rules — never violate

1. **Cleartext PII never appears** in logs, audit records, metrics, error messages, stack traces, or any outbound payload to Anthropic. Audit records store hashes, not values. Lint enforces `no-console` for this reason; use the structured logger.
2. **The only path to the Anthropic API is through this gateway.** Consumer Claude (Free/Pro/Max keys) is explicitly blocked. The gateway probes the key on startup and refuses to boot if it isn't a verified commercial key.
3. **Fail-closed.** If redaction fails, recognizers fail to load, the engine is unreachable, or face/signature detection is unavailable — the request **fails**. Never bypass redaction to keep a feature working.
4. **Tests must cover recall + precision against `qa/corpus/`** before merge. CI gates regressions per Phase 12 thresholds (SSN/EIN/routing recall ≥ 0.99; names/addresses ≥ 0.95; precision ≥ 0.90 across all).
5. **Every recognizer change updates `compliance/recognizers.md`** with pattern, source, and measured FP/FN rate from the QA corpus.
6. **Real client data never enters the repo.** `qa/corpus/real/` is gitignored. Synthetic fixtures only — names/SSNs/EINs in valid-format-but-not-issued ranges via Faker.

## Stack

- **Gateway** — Node.js 24 + TypeScript + Express. (BUILD_PLAN.md §2.1 says Node 20; the active kickoff prompt bumped to 24. Treat 24 as canonical and reconcile BUILD_PLAN.md when convenient.)
- **Engine** — Python 3.12 + FastAPI + Presidio + spaCy. Internal-only; never exposed externally.
- **Admin** — React 18 + Vite + TypeScript + shadcn/ui + Tailwind.
- **Client SDK** — TypeScript, mirrors `@anthropic-ai/sdk` shape so Vibe app integration is a one-line import swap.
- **Storage** — Postgres 16 (token vault, audit, policies), Redis 7 (sessions, rate limits), BullMQ (batch jobs).
- **Tooling** — pnpm workspaces (Node), uv (Python), Docker Compose, Make.
- **License** — PolyForm Internal Use 1.0.0.

## Repo layout (target — built incrementally per BUILD_PLAN.md)

```
apps/
  gateway/     Node Express service — Anthropic-compatible /v1/messages    (Phase 7+)
  engine/      Python FastAPI + Presidio                                    (Phase 2+)
  admin/       React admin UI                                               (Phase 13)
packages/
  client/      @kisaesdevlab/vibe-shield-client SDK                         (Phase 14)
  schema/      Drizzle schema, shared with gateway                          (Phase 5)
  shared-types/                                                             (as needed)
compliance/    Engagement-letter language, WISP, peer-review FAQ, vendor binder (Phase 22)
qa/            Synthetic corpus + recall/precision harness                  (Phase 12)
```

## Common commands

```bash
# Install everything (Node + Python)
make install

# Local dev infra (Postgres + Redis only, app services come up via compose profile)
make dev
docker compose --profile app up --build   # once gateway/engine/admin Dockerfiles exist

# Phase gate
make verify                                # lint + typecheck + tests

# Targeted
pnpm -r test                               # all Node workspaces
cd apps/engine && uv run pytest            # engine tests
cd apps/engine && uv run pytest tests/test_recognizers.py::test_us_ein -v   # single test
pnpm --filter @kisaesdevlab/vibe-shield-client test                          # one workspace
```

## Conventions

- **Logging**: structured JSON with correlation IDs. Never log request/response bodies. The Node `no-console` lint rule blocks accidental `console.log`.
- **Tokens**: format `<{ENTITY}_{N}>` — deterministic within a session, randomized across sessions (privacy property: Anthropic cannot correlate sessions).
- **Sessions**: every request belongs to a session; idempotent re-redaction in the same session yields identical tokens.
- **Policies**: versioned. Any policy change creates a new version; old versions retained for audit. Resolution priority: request → user → app → tenant → built-in.
- **Migrations**: numbered sequentially under `packages/schema/migrations/`. Reversible.
- **Encryption**: AES-256-GCM at rest for `cleartext_encrypted` with a per-tenant DEK wrapped by an appliance-level KEK. KEK lives in env, never in DB.

## Working with BUILD_PLAN.md

Each phase ends with **green tests + a doc update**. After completing a phase:

1. Run `make verify`.
2. Update `CHANGELOG.md` with what shipped.
3. Open a PR. The PR template requires answering "redaction recall regression run? Y/N".

Do not skip ahead — recognizers (Phase 3) depend on the engine scaffold (Phase 2); the gateway proxy (Phase 8) depends on the token vault (Phase 5); and so on.

## When you're stuck

- Recognizer false negatives → check `vs_recognizer_misses` table (Phase 4 — backstop log) and the QA corpus.
- Streaming weirdness → token map must persist across SSE chunks; check `apps/gateway/src/orchestrator/`.
- Compliance question on a design choice → BUILD_PLAN.md §1 lists the six compliance objectives the build must satisfy. Map your change back to one of them.

## What this repo is not

- Not a SaaS. Self-hosted only in v1.
- Not multi-LLM. Anthropic only — adding a provider requires a new compliance memo.
- Not a general-purpose PII tool. Tuned for CPA workflows: bank statements, 1099/W-2, engagement docs, check images.
