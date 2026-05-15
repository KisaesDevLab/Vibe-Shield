#!/usr/bin/env node
/**
 * One-shot migration runner.
 *
 * Used by:
 *   - The appliance bootstrap (Phase 21) before starting the gateway.
 *   - `make migrate` for local dev.
 *   - The deploy pipeline as a separate job before rolling out the
 *     gateway (v1.0.1 §1.4 — preferred over startup migrations).
 *
 * Reads DATABASE_URL from env. Exits 0 on success, non-zero on
 * failure. Drizzle's __drizzle_migrations table tracks applied
 * migrations so re-runs are idempotent.
 */

import { createDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL env var required');
  }
  const handle = createDatabase(url, { max: 2 });
  try {
    // eslint-disable-next-line no-console
    console.error(`Running migrations against ${url.replace(/:[^:@]*@/, ':***@')}`);
    await runMigrations(handle);
    // eslint-disable-next-line no-console
    console.error('migrations applied.');
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`migrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
