# Vibe Shield — standalone install one-pager

> **Running on Vibe-Appliance?** Stop reading this. The appliance reads
> [`../.appliance/manifest.json`](../.appliance/manifest.json) and handles
> installation, env rendering, Caddy config, DB bootstrap, and updates
> for you. Use the admin console's app toggle. The steps below are for
> bolting Vibe Shield onto a docker-compose stack you maintain yourself.

Target audience: an operator wiring Vibe Shield into an existing
docker-compose deployment they own end-to-end. Assumes you already have
Postgres + Redis + a reverse proxy (Caddy, Traefik, nginx) + optional
Tailscale running.

Estimated time: 10 minutes for a fresh install, 5 for an upgrade.

## What you're installing

3 containers:

| Container | Port (internal) | External via Caddy | Purpose |
|---|---|---|---|
| `vibe-shield-engine` | 8000 | **no** (internal only) | Python redaction engine — Presidio + spaCy lg + custom recognizers |
| `vibe-shield-gateway` | 8080 | `gateway.shield.<domain>` (Tailscale-only by default) | Anthropic-Messages-compatible API. Self-migrates on boot when `MIGRATIONS_AUTO=true` (the default in this fragment) — no separate migrate one-shot needed. |
| `vibe-shield-admin` | 80 | `shield.<domain>` (Tailscale-only by default) | React SPA for key issuance, audit browsing, policy viewing |

Shared infra: the appliance's existing Postgres + Redis. Vibe Shield uses table prefix `vs_*` (database `vibe_shield_db`, role `vibeshield`) and Redis DB index `/5` (this is the canonical allocation in the appliance's manifest catalog; do not change without re-checking other apps' indices to avoid collisions).

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

> **`ANTHROPIC_API_KEY` is the bootstrap key.** As of v1.2 the admin SPA can rotate the Anthropic key without a redeploy — the new value is persisted encrypted under `VS_KEK` and overrides this env value on the next request. The env var still needs to be set at first boot so the gateway has something to probe and start with; after that, day-to-day rotations happen at `https://shield.<domain>/` → **Anthropic Probe** → *Set / rotate key*.

#### Magic-link sign-in (Phase 24, v1.3+)

As of v1.3, operators can sign in to the admin SPA with a one-time email link instead of pasting `GATEWAY_ADMIN_KEY`. The admin-key path stays available as a fallback. To enable magic-link sign-in:

| Var | Required? | What |
|---|---|---|
| `PUBLIC_URL` | yes (for magic-link) | The public origin where the admin SPA is reachable, e.g. `https://shield.firm.example`. The magic-link URL in the email is built off this. |
| `SMTP_HOST` | yes (for magic-link) | SMTP relay. When unset, `/api/auth/request-link` returns 501 and operators must use the admin-key fallback. |
| `SMTP_PORT` | no (default `587`) | 465 for implicit TLS; 587 for STARTTLS. |
| `SMTP_USER` / `SMTP_PASSWORD` | optional | Skip for un-authenticated local relays. |
| `SMTP_FROM` | recommended | The `From:` address. Defaults to `vibe-shield@$SMTP_HOST`. |
| `SMTP_TLS` | no (default `true`) | Set to `false` for relays that don't support STARTTLS (test envs only). |
| `BOOTSTRAP_ADMIN_EMAIL` | recommended | On first boot, if `vs_users` is empty, this email is created as the first `is_org_admin` user with admin role on every module. Idempotent — skipped if any user already exists. |
| `SESSION_IDLE_TTL_MINUTES` | no (default `1440`) | Sliding session idle TTL. |
| `MAGIC_LINK_TTL_MINUTES` | no (default `15`) | One-time link TTL. |

Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when `NODE_ENV=production`. The admin SPA + the gateway must be same-origin for the cookie to flow — the `caddy.snippet` in this directory routes both `/v1/admin/*` and `/api/auth/*` to the gateway under `shield.<domain>` for exactly that reason.

Optional: `VIBE_SHIELD_ADMIN_BASE_PATH` (defaults to `/`). Set this to e.g. `/shield/` when you front the admin container with a reverse proxy that mounts the UI under a path prefix and strips that prefix before hitting nginx. The value MUST end with a slash. The admin nginx entrypoint shim (`/docker-entrypoint.d/40-base-path.sh`) reads this and sed-substitutes the SPA bundle's `/__VIBE_BASE_PATH__/` sentinel at container start.

### 4. Wire up Caddy

```bash
cat /path/to/vibe-shield/appliance/caddy.snippet >> /opt/vibe/appliance/Caddyfile
# Or use the @import directive; whichever your appliance prefers.
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### 5. Boot (migrations run automatically)

```bash
# The gateway entrypoint runs `node dist/migrate.js` on startup when
# MIGRATIONS_AUTO=true (default in the fragment). Drizzle's
# __drizzle_migrations table keeps re-runs idempotent. No separate
# bootstrap profile or one-shot job needed.
docker compose up -d vibe-shield-engine vibe-shield-gateway vibe-shield-admin
```

If you prefer the v1.0/v1.1 separate-migrate pattern for blue-green
schema rollout control, set `VIBE_SHIELD_MIGRATIONS_AUTO=false` in your
.env and run migrations as a one-shot before bringing the gateway up:

```bash
docker run --rm --network "${VIBE_NETWORK_NAME:-vibe-network}" \
  -e DATABASE_URL="$VIBE_SHIELD_DATABASE_URL" \
  ghcr.io/kisaesdevlab/vibe-shield-gateway:${VIBE_SHIELD_VERSION:-v1.1.5} \
  node dist/migrate.js
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
# Bump to the new version. Replace v1.1.6 with whatever tag you're moving to.
NEW=v1.1.6
sed -i "s/^VIBE_SHIELD_VERSION=.*/VIBE_SHIELD_VERSION=${NEW}/" /opt/vibe/appliance/.env

# Pull new images
docker compose pull vibe-shield-engine vibe-shield-gateway vibe-shield-admin

# Rolling restart — gateway entrypoint runs migrations before serving
# when MIGRATIONS_AUTO=true (default).
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
