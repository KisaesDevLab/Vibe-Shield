# Vibe Shield

Self-hosted PII redaction gateway between Vibe apps and the Anthropic Claude API. Runs on the Vibe Appliance, performs local PII detection (text **and** images) with Microsoft Presidio plus CPA-domain custom recognizers, swaps cleartext for deterministic per-session tokens, proxies the Anthropic Messages API, and re-identifies the response per policy. Names, SSNs, EINs, bank account / routing numbers, faces, and signatures never leave the firm's environment.

The full design — compliance objectives, architecture, phased build plan, and acceptance criteria — lives in [BUILD_PLAN.md](./BUILD_PLAN.md). Working agreements for Claude Code are in [CLAUDE.md](./CLAUDE.md).

## Status

**Pre-alpha.** Phases 1–4 of BUILD_PLAN.md are complete: repo foundation, FastAPI engine with Presidio + spaCy, seven CPA-domain custom recognizers, the whitelist post-processor, and the six regex backstops with miss logging. Sanitized 422 / 500 / 503 error envelopes enforce hard-rule #1 in error paths. Gateway, admin UI, token vault, and client SDK arrive in their respective phases.

## Quickstart

Requires Node.js ≥ 24, pnpm ≥ 9, Python 3.12, [uv](https://docs.astral.sh/uv/), and Docker.

```bash
pnpm install
make dev          # starts Postgres (host :5436) + Redis (host :6379)
make verify       # lint + typecheck + tests across all workspaces

# Schema integration tests need DATABASE_URL — point at the dev Postgres:
export DATABASE_URL="postgres://vibe:vibe@localhost:5436/vibe_shield"
pnpm --filter @kisaesdevlab/vibe-shield-schema test
```

Postgres is mapped to host port **5436** (not the default 5432) so it doesn't collide with system Postgres or other Vibe-stack databases. Override with `POSTGRES_PORT=…` if needed.

App services come up once their phases land:

```bash
docker compose --profile app up --build
```

## Stack

| Component | Tech | Phase |
|-----------|------|-------|
| `vibe-shield-gateway` | Node 24 + TypeScript + Express | 7–10 |
| `vibe-shield-engine` | Python 3.12 + FastAPI + Presidio | 2–6, 17 |
| `vibe-shield-admin` | React 18 + Vite + shadcn/ui | 13 |
| `@kisaesdevlab/vibe-shield-client` | TypeScript SDK | 14 |
| Storage | Postgres 16 + Redis 7 + BullMQ | 5–6, 8 |

## License

[PolyForm Internal Use 1.0.0](./LICENSE). Distribution requires a separate commercial license — contact KisaesDevLab.
