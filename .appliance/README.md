# `.appliance/` — Vibe-Appliance integration

This directory is the canonical hook for the **Vibe-Appliance** meta-installer
(`kwkcp/Vibe-Appliance`). The appliance reads `manifest.json` at install / enable
time and bakes the contents into its console's app registry, per
[`docs/MANIFEST_SCHEMA.md`](https://github.com/kwkcp/Vibe-Appliance/blob/main/docs/MANIFEST_SCHEMA.md)
in that repo.

## Two install paths

| Path | What you use | When |
|---|---|---|
| **Appliance** | `.appliance/manifest.json` (this dir) | You are running on Vibe-Appliance. The appliance owns the compose overlay, Caddy config, env rendering, DB bootstrap, image lifecycle. You toggle Vibe Shield on/off from the admin console. |
| **Standalone** | `appliance/` (sibling dir — the legacy paste-in artifacts) | You are bolting Vibe Shield onto an existing docker-compose stack you maintain yourself. You hand-merge the compose fragment, hand-edit Caddy, hand-populate `.env`. |

Both paths produce the same three containers (`vibe-shield-engine`,
`vibe-shield-gateway`, `vibe-shield-admin`) running the same GHCR images. The
gateway image's entrypoint honors `MIGRATIONS_AUTO=true` either way, so
neither path needs a separate `vibe-shield-migrate` one-shot.

## What the appliance does with this manifest

1. **Routing.** Renders two Caddy vhosts:
   - `shield.<domain>` → admin SPA, with `/v1/admin/*` proxied to the gateway.
   - `gateway.shield.<domain>` → entire gateway (the Anthropic-shaped API).
2. **Database.** Creates `vibe_shield_db` + role `vibeshield` on the shared
   Postgres. Per-app role gets grants on its own database only. Vibe Shield's
   migrations create `vs_*` tables under that database.
3. **Redis.** Allocates logical DB index `/3` … `/5` was free at integration time;
   the appliance pins it via the manifest's `redis.db` field.
4. **Env file.** Renders `/opt/vibe/env/vibe-shield.env` from the appliance's
   per-app env template. Secrets that must survive across re-renders (`VS_KEK`,
   `GATEWAY_ADMIN_KEY`) are generated once and preserved on subsequent renders —
   rotating `VS_KEK` after install would unrecoverably brick the encrypted
   vault.
5. **Lifecycle.** Pull → bootstrap DB → compose up → poll `/health` → reload Caddy.
   Idempotent. Re-runnable from any partial-failure state.

## Operator-facing followups after enable

- `GATEWAY_ADMIN_KEY` is written to `/opt/vibe/CREDENTIALS.txt`. Operator pastes
  it into the admin login form at `https://shield.<domain>`.
- `ANTHROPIC_API_KEY` is inherited from the appliance-wide `appliance.env`
  (Settings → AI → Anthropic API key). One key, every Vibe app that uses
  Anthropic shares it; per-app override is possible.
- Tailscale-only ingress is the appliance's posture for any subdomain not
  explicitly LAN-exposed. Set per-subdomain by the appliance, not by this
  manifest.

## Open coordination points with Vibe-Appliance

The manifest declares two `from:` resolvers that the appliance's env renderer
does **not yet** implement:

- `"from": "generated:base64-32bytes"` (for `VS_KEK`)
- `"from": "generated:hex32"` (for `GATEWAY_ADMIN_KEY`)

Both follow the same generate-and-preserve pattern the appliance already uses
ad-hoc for `CONNECT_INTAKE_ENCRYPTION_KEY` in `lib/enable-app.sh`. Until the
generic resolvers land, the appliance template needs a per-marker substitution
for `@VS_KEK@` and `@GATEWAY_ADMIN_KEY@` analogous to the existing
`@CONNECT_INTAKE_ENCRYPTION_KEY@` path.

The appliance side also needs:
- `apps/vibe-shield.yml` (compose overlay)
- `env-templates/per-app/vibe-shield.env.tmpl` (env template)
- `console/manifests/vibe-shield.json` (mirror of this file until upstream-manifest fetch lands)
- `console/ui/static/logos/vibe-shield.svg` (card logo)
- Add `5193` + `5194` to the `emergency-proxy` ports list in `docker-compose.yml`
