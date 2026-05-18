# Vibe Shield — top-level dev tasks.
#
# Assumes a POSIX shell. On Windows, run from WSL or Git Bash.
# `make verify` is the gate the kickoff prompt requires after each phase.

SHELL := /bin/sh
.DEFAULT_GOAL := help

# Detect whether the engine workspace has been scaffolded yet (Phase 2).
ENGINE_PRESENT := $(shell test -f apps/engine/pyproject.toml && echo 1 || echo 0)

.PHONY: help dev down ps logs install lint typecheck test build verify clean migrate rotate-kek-dry rotate-kek-apply audit-digest wipe-vault-dry wipe-vault-apply

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

dev: ## Bring up Postgres + Redis for local development
	docker compose up -d postgres redis
	@echo ""
	@echo "Postgres on :5432, Redis on :6379."
	@echo "Start gateway / engine / admin from their app directories, or:"
	@echo "  docker compose --profile app up --build"

down: ## Stop and remove dev containers (volumes preserved)
	docker compose down

ps: ## Show compose status
	docker compose ps

logs: ## Tail compose logs
	docker compose logs -f --tail=200

install: ## Install all workspace deps (pnpm + uv); engine sync also pulls en_core_web_sm
	pnpm install
ifeq ($(ENGINE_PRESENT),1)
	cd apps/engine && uv sync
endif

lint: ## Lint all workspaces
	pnpm run lint
ifeq ($(ENGINE_PRESENT),1)
	cd apps/engine && uv run ruff check .
endif

typecheck: ## Typecheck all workspaces
	pnpm run typecheck
ifeq ($(ENGINE_PRESENT),1)
	cd apps/engine && uv run mypy app || true
endif

test: ## Unit tests for all workspaces
	pnpm run test
ifeq ($(ENGINE_PRESENT),1)
	cd apps/engine && uv run pytest
endif

build: ## Production build for all workspaces
	pnpm run build

verify: lint typecheck boundary test ## Gate run after each phase (lint + typecheck + boundary + tests)
	@echo "verify: ok"

boundary: ## Phase 25 G2.9 — Anthropic SDK boundary check
	sh scripts/check-anthropic-boundary.sh

migrate: ## Run pending DB migrations (Drizzle)
	pnpm --filter @kisaesdevlab/vibe-shield-schema migrate

rotate-kek-dry: ## KEK rotation dry-run (env: OLD_VS_KEK NEW_VS_KEK DATABASE_URL)
	pnpm --filter @kisaesdevlab/vibe-shield-schema rotate-kek -- --dry-run

rotate-kek-apply: ## KEK rotation apply — only after a successful dry-run
	pnpm --filter @kisaesdevlab/vibe-shield-schema rotate-kek -- --apply

audit-digest: ## Write yesterday's audit digest to compliance/audit-digests (cron: 0 5 0 * * *)
	pnpm --filter @kisaesdevlab/vibe-shield-schema audit-digest

wipe-vault-dry: ## Vault uninstall dry-run — shows row counts; no writes
	pnpm --filter @kisaesdevlab/vibe-shield-schema wipe-vault -- --dry-run

wipe-vault-apply: ## Vault uninstall — drops every vs_* table. Requires VIBE_SHIELD_WIPE_CONFIRM=WIPE-VAULT.
	pnpm --filter @kisaesdevlab/vibe-shield-schema wipe-vault -- --apply

clean: ## Remove build artifacts (node_modules, dist, caches)
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/dist packages/*/dist
	rm -rf apps/engine/.venv apps/engine/.ruff_cache apps/engine/.mypy_cache apps/engine/.pytest_cache
