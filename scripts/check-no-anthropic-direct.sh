#!/usr/bin/env bash
# Hard rule #2 enforcement.
# The Anthropic SDK may be imported only from apps/gateway/. Every other
# Vibe-Shield TS source file must go through @kisaesdevlab/vibe-shield-client
# (or, for cross-repo Vibe apps consuming Shield, that same client).

set -euo pipefail

# Find direct imports outside apps/gateway/.
hits=$(grep -rE "from ['\"]@anthropic-ai/sdk" \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=.shield-build \
  apps packages 2>/dev/null \
  | grep -v "^apps/gateway/" \
  | grep -v "^packages/client/" \
  || true)

if [ -n "$hits" ]; then
  echo "FAIL: hard rule #2 — direct @anthropic-ai/sdk imports outside apps/gateway/ and packages/client/:"
  echo "$hits"
  exit 1
fi

echo "ok: no @anthropic-ai/sdk imports outside apps/gateway/ and packages/client/"
