#!/usr/bin/env bash
# Helper to (re)generate the uv lockfile for the engine. Run before CI
# expects --frozen-lockfile semantics on Python.
set -euo pipefail
cd "$(dirname "$0")/../apps/engine"
$HOME/.local/bin/uv lock
echo "uv.lock regenerated."
