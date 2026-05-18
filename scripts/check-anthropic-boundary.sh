#!/usr/bin/env sh
# Phase 25 G2.9 — Anthropic egress boundary check.
#
# The @anthropic-ai/sdk must only be imported from
# apps/gateway/src/anthropic/. Anywhere else is a regression that
# would let a new feature talk to api.anthropic.com without going
# through the egress wrapper (ZDR / probe / audit / spend-cap / model
# allowlist). ESLint also enforces this; this script is the CI
# belt-and-braces in case lint is skipped or the rule is wrongly
# disabled.
#
# Exit codes: 0 = clean, 1 = offending imports found, 2 = ripgrep
# missing.

set -eu

cd "$(dirname "$0")/.."

# Match real import / require references, not comments or doc strings.
#   import ... from '@anthropic-ai/sdk'
#   import ... from "@anthropic-ai/sdk/resources/..."
#   require('@anthropic-ai/sdk')
PATTERN="(from[[:space:]]+['\"]@anthropic-ai/sdk|require\\([[:space:]]*['\"]@anthropic-ai/sdk)"

# Scope: apps/gateway/src/**/*.ts only. The boundary is about the
# gateway runtime not bypassing its own egress wrapper — packages/client
# is a drop-in SDK replacement and intentionally re-exports the SDK
# types; packages/schema doesn't touch Anthropic at all. dist/ outputs
# are excluded.
#
# Prefer ripgrep when available; fall back to find + grep so this works
# on a bare Windows Git Bash without rg.
if command -v rg >/dev/null 2>&1; then
  ALL="$(rg --type ts --files-with-matches --glob '!**/dist/**' --regexp "$PATTERN" apps/gateway/src 2>/dev/null || true)"
else
  ALL="$(find apps/gateway/src -type f -name '*.ts' -not -path '*/dist/*' -exec grep -l -E -- "$PATTERN" {} + 2>/dev/null || true)"
fi

if [ -z "$ALL" ]; then
  echo "check-anthropic-boundary: ✓ Anthropic SDK is not referenced in apps/gateway/src"
  exit 0
fi

# Filter: anything under apps/gateway/src/anthropic/ is allowed.
OFFENDERS="$(printf '%s\n' "$ALL" | grep -v 'apps/gateway/src/anthropic/' || true)"

if [ -n "$OFFENDERS" ]; then
  echo "check-anthropic-boundary: ✗ Anthropic SDK imported outside apps/gateway/src/anthropic/:" >&2
  printf '%s\n' "$OFFENDERS" >&2
  echo "" >&2
  echo "Route the call through apps/gateway/src/anthropic/holder.ts instead." >&2
  exit 1
fi

echo "check-anthropic-boundary: ✓ Anthropic SDK is only imported from the egress wrapper"
exit 0
