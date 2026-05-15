/**
 * Programmatic migration runner.
 *
 * Applies every ``NNNN_*.sql`` file under ``migrations/`` in lexical
 * order, skipping ``*.down.sql`` companions. Used by tests for setup
 * and by the appliance bootstrap (Phase 21).
 *
 * Each up-migration runs in its own transaction (defined inside the SQL
 * file via BEGIN/COMMIT). We don't yet maintain a ``schema_migrations``
 * table — Phase 7+ will add one when we ship the first non-baseline
 * migration. For now, callers should run against an empty database or
 * against one that already matches the schema.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { DatabaseHandle } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Default migrations directory: ``packages/schema/migrations``. */
export const DEFAULT_MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

export interface MigrateOptions {
  migrationsDir?: string;
  /** Drop everything in the current schema first. Tests only. */
  fresh?: boolean;
}

export async function runMigrations(
  handle: DatabaseHandle,
  options: MigrateOptions = {},
): Promise<{ applied: string[] }> {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  if (options.fresh === true) {
    await dropAllVibeShieldObjects(handle);
  }
  const entries = await readdir(dir);
  const upFiles = entries
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
  const applied: string[] = [];
  // postgres-js refuses to run multi-statement SQL containing BEGIN/COMMIT
  // through a pooled client (it can't pin the transaction to one socket).
  // Open a dedicated single-connection client off the handle's URL.
  const migrationClient = postgres(handle.url, { max: 1, idle_timeout: 5 });
  try {
    for (const name of upFiles) {
      const sql = await readFile(join(dir, name), 'utf8');
      await migrationClient.unsafe(sql);
      applied.push(name);
    }
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
  return { applied };
}

/**
 * Drop every Vibe-Shield-prefixed table + helper function in the current
 * schema. Used between integration test runs to start clean. Confined
 * to ``vs_*`` so it cannot accidentally wipe an unrelated database.
 */
export async function dropAllVibeShieldObjects(handle: DatabaseHandle): Promise<void> {
  await handle.client.unsafe(`
    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'vs_%' LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
      END LOOP;
      FOR r IN SELECT proname FROM pg_proc WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema()) AND proname LIKE 'vs_%' LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %I() CASCADE', r.proname);
      END LOOP;
    END
    $$;
  `);
}
