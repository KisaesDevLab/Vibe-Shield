# Prompt template registry

Phase 25 (G2.6) — versioned, content-addressed prompts used by the internal API (Phase 28). Each Markdown file in this directory becomes one template; the gateway loads them at startup and computes a SHA-256 of the raw file bytes. The audit row for every Claude call that uses a template records the template id + SHA so a future reviewer can prove which prompt produced which extraction.

## File format

```markdown
---
id: mybooks.bank_statement.v1
description: Categorize transactions in a bank statement
model_hint: claude-sonnet-4-6
---

You are a CPA bookkeeping assistant. The user will provide a redacted bank
statement; respond with a JSON object mapping each transaction to a
category. ...
```

Frontmatter is bounded by `---` lines. Known keys:

| Key | Required? | Notes |
|---|---|---|
| `id` | yes | Slug `[a-z0-9](\.|_|-|[a-z0-9])*`. Used as the `promptId` parameter in API calls. Must be unique across the directory. |
| `description` | no | Free text. Surfaced in the admin UI. |
| `model_hint` | no | Advisory only. The policy registry (Phase 25.G2.3 follow-up) still gates the allowlist. |

Unknown keys are silently tolerated so we can extend the format later without breaking existing files. Templates without a valid `id` are skipped at load time with a warn-level log; they do not crash the gateway.

## Versioning

Templates are immutable from the wrapper's perspective. To revise a prompt:

1. Don't edit the existing file — create a new one with a new `id` (`mybooks.bank_statement.v2`).
2. Update the caller (MyBooks, Trial Balance, etc.) to pass the new `id`.
3. The old template remains available so historical replays still work.

This is the same pattern as Anthropic's own model versioning: SHAs change with every byte, ids change only when callers should adopt a new version.

## What lives here vs. what's a runtime concern

In-tree: the templates themselves, this README, and the loader.
Runtime: the SHA is computed at startup from the file bytes — no separate manifest, no checksum file. Operators who want to vet the SHA before allowing a template into production can run `sha256sum prompts/*.md` and compare against the registry view at `GET /v1/admin/prompts`.

## Currently shipped templates

None — Phase 28 (Internal Service API) introduces the first concrete consumers (MyBooks, Trial Balance, Tax Research). The loader runs against an empty directory cleanly, so this is intentional.
