# vibe-shield-gateway

Anthropic-Messages-compatible gateway. Node.js 24 + Express 5 + TypeScript.

Sits between Vibe apps and the Anthropic Claude API: validates the Vibe-issued API key, resolves the tenant, opens / reuses a session against the token vault, calls the engine to redact, proxies to Anthropic, and re-identifies the response per policy.

**Phase 7 scope:** scaffold + auth + routing skeleton. `/v1/messages` validates the request shape and returns 501 with an Anthropic-shaped envelope. The actual Anthropic proxy + streaming + tool-use redaction land in Phase 8.

## Endpoints

| Method | Path             | Purpose                                                  |
|--------|------------------|----------------------------------------------------------|
| GET    | `/health`        | Liveness                                                 |
| GET    | `/ready`         | Readiness — DB connectivity + engine reachability        |
| POST   | `/v1/messages`   | Anthropic Messages API shape (501 until Phase 8)         |
| POST   | `/v1/sessions`   | Create a token-vault session                             |
| DELETE | `/v1/sessions/:id` | Purge a session (cascades vs_tokens)                    |
| GET    | `/openapi.json`  | OpenAPI 3.1 spec                                         |

## Auth

Every protected endpoint requires an `Authorization: Bearer vs_live_…` header. Keys are minted via the admin UI (Phase 13) or the bootstrap script. The 32-char body of the key is SHA-256-hashed and stored in `vs_api_keys`; the cleartext is shown to the operator exactly once at issuance.

## Local dev (once Phase 7 ships)

```bash
export VS_KEK="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
export DATABASE_URL="postgres://vibe:vibe@localhost:5436/vibe_shield"
export ANTHROPIC_API_KEY="sk-ant-..."

make dev                  # postgres + redis
pnpm --filter @kisaesdevlab/vibe-shield-gateway dev
```
