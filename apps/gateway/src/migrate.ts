#!/usr/bin/env node
/**
 * Gateway-image migration CLI.
 *
 * Compiled into the gateway runtime image as ``dist/migrate.js`` so:
 *
 *   1. The entrypoint (``entrypoint.sh``) can run it conditionally when
 *      ``MIGRATIONS_AUTO=true`` — the Vibe-Appliance pattern for first-
 *      enable self-migration.
 *   2. The appliance's ``update.sh`` can invoke it explicitly via the
 *      manifest's ``migrations.command: ["node", "dist/migrate.js"]`` —
 *      the rollback-safe update path runs migrations against the new
 *      image before swapping containers.
 *
 * Both paths share this single binary so behaviour is identical between
 * first enable and subsequent updates. Drizzle's ``__drizzle_migrations``
 * table makes re-runs idempotent.
 *
 * Note: the schema package ships its own ``scripts/migrate.ts`` for local
 * dev (``pnpm migrate`` via tsx). That script isn't compiled into the
 * gateway image's pruned ``node_modules``, so we re-implement the same
 * three lines here against the schema's compiled ``./db`` and
 * ``./db/migrate`` subpath exports.
 */

import { createDatabase } from '@kisaesdevlab/vibe-shield-schema/db';
import { runMigrations } from '@kisaesdevlab/vibe-shield-schema/db/migrate';

function redactDatabaseUrl(url: string): string {
  // URL-based redaction is robust against passwords containing `:` or
  // other regex-troublesome characters (`@` would already have broken a
  // postgres URL; new URL() correctly parses everything before the
  // first un-userinfo `@`). Fall back to a hard `***` literal if the
  // URL is unparseable rather than risk leaking the input.
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL env var required');
  }
  const handle = createDatabase(url, { max: 2 });
  try {
    console.error(`Running migrations against ${redactDatabaseUrl(url)}`);
    await runMigrations(handle);
    console.error('migrations applied.');
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(`migrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
