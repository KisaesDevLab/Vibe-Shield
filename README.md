# Vibe Shield

Self-hosted PII redaction gateway between Vibe apps and the Anthropic Claude API. Runs on the Vibe Appliance, performs local PII detection (text **and** images) with Microsoft Presidio plus CPA-domain custom recognizers, swaps cleartext for deterministic per-session tokens, proxies the Anthropic Messages API, and re-identifies the response per policy. Names, SSNs, EINs, bank account / routing numbers, faces, and signatures never leave the firm's environment.

The full design — compliance objectives, architecture, phased build plan, and acceptance criteria — lives in [BUILD_PLAN.md](./BUILD_PLAN.md). Working agreements for Claude Code are in [CLAUDE.md](./CLAUDE.md).

## Status

**Pre-alpha.** Phase 1 (repository foundation) is the current scope. App services (`apps/gateway`, `apps/engine`, `apps/admin`) are scaffolded in their respective phases — see BUILD_PLAN.md §4.

## Quickstart

Requires Node.js ≥ 24, pnpm ≥ 9, Python 3.12, [uv](https://docs.astral.sh/uv/), and Docker.

```bash
pnpm install
make dev          # starts Postgres + Redis
make verify       # lint + typecheck + tests across all workspaces
```

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
