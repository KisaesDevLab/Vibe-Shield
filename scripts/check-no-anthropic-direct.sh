#!/usr/bin/env bash
# Hard rule #2 enforcement.
# The Anthropic SDK may be imported only from apps/gateway/. Every other
# Vibe-Shield TS source file must go through @kisaesdevlab/vibe-shield-client
# (or, for cross-repo Vibe apps consuming Shield, that same client).
#
# v1.1 §3.12 extends the same rule to Python. The engine and any future
# Python integration MUST NOT import the official ``anthropic`` package
# directly — Vibe Shield is the only path to Anthropic.

set -euo pipefail

ts_hits=$(grep -rE "from ['\"]@anthropic-ai/sdk" \
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

if [ -n "$ts_hits" ]; then
  echo "FAIL: hard rule #2 (TS) — direct @anthropic-ai/sdk imports outside apps/gateway/ and packages/client/:"
  echo "$ts_hits"
  exit 1
fi

# v1.1 §3.12: same check for Python. The ``anthropic`` PyPI package is
# the official SDK; ``import anthropic`` or ``from anthropic`` anywhere
# in the Python tree (engine, qa harness, scripts) is a violation.
# Whitelisted paths: none in v1.1 — Python never talks to Anthropic
# directly. Add to PYTHON_ALLOW if a future cross-repo Python integration
# legitimately needs the SDK.
PYTHON_ALLOW=""
py_hits=$(grep -rE "^[[:space:]]*(from anthropic|import anthropic)\\b" \
  --include="*.py" \
  --exclude-dir=__pycache__ \
  --exclude-dir=.venv \
  --exclude-dir=node_modules \
  --exclude-dir=.shield-build \
  apps qa 2>/dev/null \
  | { if [ -n "$PYTHON_ALLOW" ]; then grep -vE "$PYTHON_ALLOW"; else cat; fi } \
  || true)

if [ -n "$py_hits" ]; then
  echo "FAIL: hard rule #2 (Python) — direct anthropic SDK imports anywhere in the Python tree:"
  echo "$py_hits"
  exit 1
fi

echo "ok: no anthropic SDK imports outside apps/gateway/ and packages/client/ (TS + Python)"
