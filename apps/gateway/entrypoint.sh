#!/bin/sh
#
# Vibe Shield gateway entrypoint.
#
# Honors MIGRATIONS_AUTO=true (Vibe-Appliance convention): runs
# migrations to completion BEFORE exec'ing the server. Drizzle's
# __drizzle_migrations table makes this idempotent across container
# restarts and re-enables.
#
# Why not always migrate: in non-appliance deployments the operator may
# prefer to run a separate one-shot migrate job (the v1.0.1 deploy
# pattern documented in the gateway Dockerfile header) for blue-green
# control over schema rollout. They unset MIGRATIONS_AUTO and run
# `docker run --rm <image> node dist/migrate.js` themselves before the
# gateway starts.
#
# Exit semantics: if migrations fail, exit non-zero — never start the
# server against an un-migrated DB. The appliance's enable-app.sh
# surfaces the container logs when the health probe times out, which it
# will because the container exited.

set -e

if [ "${MIGRATIONS_AUTO:-false}" = "true" ]; then
  # Preflight: if the migrate CLI isn't in the image, the operator is
  # running a broken/mismatched build. Bail with a clear message rather
  # than letting node print "Cannot find module 'dist/migrate.js'" and
  # exit 1 generically.
  if [ ! -f dist/migrate.js ]; then
    echo "[entrypoint] FATAL: dist/migrate.js not found in image." >&2
    echo "[entrypoint]   This image was built without the migrate CLI." >&2
    echo "[entrypoint]   Either pin to a v1.1.5+ tag or unset MIGRATIONS_AUTO" >&2
    echo "[entrypoint]   and run migrations as a separate one-shot job." >&2
    exit 2
  fi
  echo "[entrypoint] MIGRATIONS_AUTO=true; running migrations..."
  node dist/migrate.js
  echo "[entrypoint] migrations complete."
else
  echo "[entrypoint] MIGRATIONS_AUTO unset/false; skipping migrations."
fi

exec "$@"
