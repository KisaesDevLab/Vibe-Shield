# Vibe Shield — appliance install one-pager

Target audience: the appliance operator wiring Vibe Shield into an existing Vibe Appliance docker-compose deployment. Assumes you already have Postgres + Redis + Caddy + Tailscale running.

Estimated time: 10 minutes for a fresh install, 5 for an upgrade.

## What you're installing

3 containers + 1 one-shot:

| Container | Port (internal) | External via Caddy | Purpose |
|---|---|---|---|
| `vibe-shield-engine` | 8000 | **no** (internal only) | Python redaction engine — Presidio + spaCy lg + custom recognizers |
| `vibe-shield-gateway` | 8080 | `gateway.shield.<domain>` (Tailscale-only by default) | Anthropic-Messages-compatible API |
| `vibe-shield-admin` | 80 | `shield.<domain>` (Tailscale-only by default) | React SPA for key issuance, audit browsing, policy viewing |
| `vibe-shield-migrate` | — | — | One-shot: applies DB migrations on bootstrap + every upgrade |

Shared infra: the appliance's existing Postgres + Redis. Vibe Shield uses table prefix `vs_*` and Redis DB index `/3` by default.

## Prereqs

- [ ] Postgres 16+ reachable from the appliance Docker network as `vibe-postgres:5432`
- [ ] Redis 7+ reachable as `vibe-redis:6379`
- [ ] Caddy with a wildcard cert for `*.<your-appliance-domain>`
- [ ] Tailscale tailnet configured (or override the `tailscale_only` matcher in `caddy.snippet`)
- [ ] A commercial Anthropic API key (NOT a Claude.ai consumer key — gateway refuses to boot on consumer keys)

## Install

### 1. Drop in the compose fragment

```bash
# In your appliance repo (e.g., /opt/vibe/appliance/)
cp /path/to/vibe-shield/appliance/docker-compose.fragment.yml ./shield.yml

# Either merge the services block into the main compose, or use the
# multi-file include pattern:
docker compose -f docker-compose.yml -f shield.yml ...
```

### 2. Generate the secrets

```bash
# AES-256-GCM key. ONE-TIME per appliance. Store in your secret manager.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Admin API key for /v1/admin/*
echo "vs-admin-$(openssl rand -hex 16)"
```

### 3. Populate `.env`

```bash
cp /path/to/vibe-shield/appliance/env.example /opt/vibe/appliance/.env
$EDITOR /opt/vibe/appliance/.env
```

Required fields: `ANTHROPIC_API_KEY`, `VS_KEK`, `VIBE_SHIELD_DATABASE_URL`, `VIBE_SHIELD_REDIS_URL`, `VIBE_SHIELD_ADMIN_KEY`.

### 4. Wire up Caddy

```bash
cat /path/to/vibe-shield/appliance/caddy.snippet >> /opt/vibe/appliance/Caddyfile
# Or use the @import directive; whichever your appliance prefers.
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### 5. Apply migrations + boot

```bash
# Run migrations as a one-shot first (creates the vs_* tables).
# Idempotent — re-running is safe.
docker compose --profile bootstrap run --rm vibe-shield-migrate

# Then start the long-running services.
docker compose up -d vibe-shield-engine vibe-shield-gateway vibe-shield-admin
```

### 6. Verify

```bash
# Engine healthy + 34 recognizers loaded
docker compose exec vibe-shield-engine \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"

# Gateway up + Anthropic probe succeeded
docker compose exec vibe-shield-gateway \
  node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"

# Admin UI reachable from your Tailscale device
curl -sI https://shield.<your-domain>/ | head -1   # expect 200 OK

# Anthropic probe via admin route (uses GATEWAY_ADMIN_KEY)
curl -s -X POST -H "X-Admin-Key: $VIBE_SHIELD_ADMIN_KEY" \
  https://gateway.shield.<your-domain>/v1/admin/anthropic/probe
# Expect: {"ok":true}
```

### 7. Issue tenant API keys

Each Vibe app (MyBooks, Trial Balance, Tax Research, Converter, etc.) needs its own `vs_live_*` key. Issue via the admin UI at `https://shield.<your-domain>` OR via the API:

```bash
curl -s -X POST -H "X-Admin-Key: $VIBE_SHIELD_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"tenantId":"mybooks-prod","appId":"mybooks","label":"mybooks-prod-2026"}' \
  https://gateway.shield.<your-domain>/v1/admin/api-keys
# Response: {"id":"<hex>","key":"vs_live_..."} — copy the key ONCE; never re-fetchable
```

### 8. Point Vibe apps at the gateway

For each Vibe app's docker-compose env:

```yaml
environment:
  ANTHROPIC_BASE_URL: http://vibe-shield-gateway:8080
  ANTHROPIC_API_KEY: vs_live_...   # the tenant key from step 7
```

## Upgrade

```bash
# Bump version in .env or compose
sed -i 's/VIBE_SHIELD_VERSION=v1.1.[0-9]/VIBE_SHIELD_VERSION=v1.1.3/' /opt/vibe/appliance/.env

# Pull new images
docker compose pull vibe-shield-engine vibe-shield-gateway vibe-shield-admin

# Run migrations FIRST (still idempotent)
docker compose --profile bootstrap run --rm vibe-shield-migrate

# Rolling restart
docker compose up -d --force-recreate vibe-shield-engine vibe-shield-gateway vibe-shield-admin
```

## Routine ops

| Task | Command |
|---|---|
| Daily audit digest | `0 5 0 * * * docker compose exec vibe-shield-gateway node packages/schema/dist/scripts/write-audit-digest.js` |
| KEK rotation (annual or post-incident) | `make rotate-kek-dry` then `make rotate-kek-apply` |
| Re-probe Anthropic key | `curl -X POST -H "X-Admin-Key: $KEY" $GW/v1/admin/anthropic/probe` |
| Browse audit log | Admin UI → Audit Log; or `GET /v1/admin/audit?tenant_id=...&limit=200` |

## Uninstall (secure wipe)

```bash
# DRY-RUN: see what would be wiped
make wipe-vault-dry

# APPLY: triple-gated — env confirm, --apply flag, interactive row count
VIBE_SHIELD_WIPE_CONFIRM=WIPE-VAULT make wipe-vault-apply

# Tear down containers + delete VS_KEK from the appliance secret manager.
docker compose down vibe-shield-engine vibe-shield-gateway vibe-shield-admin
```

After wipe + KEK deletion, the encrypted vault is unrecoverable.

## Hard-rule posture (compliance auditors)

- **No cleartext PII anywhere**: gateway logs, engine logs, `vs_audit.payload_hash`, `vs_tokens.cleartext_encrypted` (AES-256-GCM at rest), spend records — all hashed or encrypted. Verified end-to-end via 2 verification rounds + code review (`.shield-build/VERIFY_REPORT_*.md`).
- **Commercial-key-only**: gateway probes Anthropic at startup; consumer keys (Free/Pro/Max) rejected.
- **Fail-closed**: every error path returns 4xx/5xx; no degraded fallback.
- **Audit-immutable**: `vs_audit` has a PG trigger blocking UPDATE/DELETE; daily SHA-256 hash-chain digest written to `compliance/audit-digests/<DATE>.txt` with mode 0440 + `wx` flag.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Gateway exits 1 on boot with `ConsumerKeyError` | Anthropic key is a Claude.ai consumer key | Get a commercial key from console.anthropic.com |
| Engine logs `ImportError: pyzbar` | libzbar0 missing in image | Pin a v1.1.1+ tag; older images had the dep gap |
| `/v1/admin/api-keys` returns 401 with `missing Authorization header` | Mounted under v1 tenant router | Pin v1.1.1+ (Defect #4 fix) |
| Migrations refuse to apply: `relation already exists` | Pre-Drizzle install | Pin v1.0.1+ (uses `__drizzle_migrations` table) |
| 429 has no `Retry-After` header | Pre-v1.1.2 | Upgrade to v1.1.2+ |
