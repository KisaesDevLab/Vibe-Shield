#!/bin/sh
# 40-base-path.sh — bake the runtime mount point into the SPA bundle.
#
# Sed-substitutes the build-time sentinel `/__VIBE_BASE_PATH__/` in the
# admin bundle with the value of $VITE_BASE_PATH, in-place across every
# .html / .js / .css file under $HTML_ROOT. Lets one image work at any
# mount point:
#
#   - Vibe-Appliance path-prefix mode    → VITE_BASE_PATH=/shield/
#   - Dedicated subdomain (domain mode)  → VITE_BASE_PATH=/
#   - Operator-mounted at custom prefix  → whatever they set
#
# Idempotent: subsequent runs find no sentinel left and become a no-op.
# Why nginx /docker-entrypoint.d: the official nginx image's
# /docker-entrypoint.sh scans this directory and runs *.sh files in
# lexicographic order before exec'ing nginx — so the substitution
# happens AFTER the container is launched with its actual env but
# BEFORE nginx serves the first request.

set -e

VITE_BASE_PATH="${VITE_BASE_PATH:-/}"

# Normalize to /<...>/ shape (leading + trailing slash), so an operator
# setting VITE_BASE_PATH=shield or /shield or shield/ all collapse to
# the canonical /shield/ form.
case "$VITE_BASE_PATH" in
  /*) ;;
  *) VITE_BASE_PATH="/$VITE_BASE_PATH" ;;
esac
case "$VITE_BASE_PATH" in
  */) ;;
  *) VITE_BASE_PATH="${VITE_BASE_PATH}/" ;;
esac

HTML_ROOT="${HTML_ROOT:-/usr/share/nginx/html}"
SENTINEL='/__VIBE_BASE_PATH__/'

# Fail-closed: if the sentinel isn't in the bundle, the build is wrong
# (Vite config drifted, or this script is running against a non-Shield
# image by mistake). Per hard rule 3, refuse to serve a misconfigured
# bundle rather than silently letting nginx serve assets at the wrong
# base path. The first invocation always finds the sentinel; subsequent
# invocations after a container restart have already substituted it —
# detect that case via the marker file and skip.
MARKER="${HTML_ROOT}/.vibe-base-path-substituted"
if [ -f "$MARKER" ]; then
  echo "[40-base-path] already substituted (marker present); skipping."
else
  # Use `find ... -exec grep -l` for portability across alpine (busybox
  # grep, which lacks --include) and debian (GNU grep). The image is
  # nginx:alpine today but we don't want a base-image change to silently
  # break this check.
  # *.map included so Vite-emitted source maps get the sentinel
  # substituted too — browser dev tools follow the sourceMappingURL
  # comment in the .js file and load the .map; if the map still
  # contains the literal sentinel, breakpoints and source-mapped
  # stack traces show the wrong paths. Build ships .map files
  # because vite.config.ts sets sourcemap: true.
  matches=$(find "$HTML_ROOT" -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.map' \) \
              -exec grep -l "$SENTINEL" {} + 2>/dev/null | wc -l)
  if [ "$matches" -eq 0 ]; then
    echo "[40-base-path] FATAL: sentinel '$SENTINEL' not found in bundle." >&2
    echo "[40-base-path]   This is a build defect — the Vite config must use" >&2
    echo "[40-base-path]   base: '$SENTINEL' for production builds." >&2
    exit 1
  fi
  echo "[40-base-path] substituting $SENTINEL -> $VITE_BASE_PATH in $matches files under $HTML_ROOT"
  # Use '#' as the sed delimiter — '#' cannot appear in a URL path
  # component (URL fragments are browser-side only, never in a server
  # path prefix), so VITE_BASE_PATH cannot collide with it. '|' was the
  # original choice but technically '|' is legal in URL paths if not
  # percent-encoded; using '#' removes that edge-case.
  find "$HTML_ROOT" -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.map' \) \
    -exec sed -i "s#$SENTINEL#$VITE_BASE_PATH#g" {} +
  touch "$MARKER"
fi

echo "[40-base-path] done."
