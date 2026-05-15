/**
 * Migration runner — Drizzle's official ``migrate`` against
 * ``drizzle-orm/postgres-js/migrator``.
 *
 * Drizzle reads ``migrations/meta/_journal.json`` to know which SQL
 * files to apply (in order, by ``idx``). Each .sql file is split on
 * ``--> statement-breakpoint`` markers and each statement runs in its
 * own transaction. Already-applied migrations are tracked in a
 * ``__drizzle_migrations`` table that Drizzle creates in a ``drizzle``
 * schema — that gives us idempotent ``runMigrations`` against a
 * partially-migrated DB, which the v1.0 hand-rolled runner did not.
 *
 * For tests we expose a ``fresh`` mode that drops every ``vs_*``
 * object plus the ``drizzle`` schema, then re-applies. Test-only —
 * production deployments never call ``fresh``.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
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
): Promise<void> {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  if (options.fresh === true) {
    await dropAllVibeShieldObjects(handle);
  }
  // Drizzle's migrator pins itself to a single connection; that
  // satisfies postgres-js's UNSAFE_TRANSACTION constraint without our
  // own juggling.
  const client = postgres(handle.url, { max: 1, idle_timeout: 5 });
  try {
    const db = drizzle(client);
    await drizzleMigrate(db, { migrationsFolder: dir });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Drop every Vibe-Shield-prefixed table plus Drizzle's tracking
 * schema. Used between integration test runs to start clean. Confined
 * to ``vs_*`` and the ``drizzle`` schema so it cannot accidentally
 * wipe an unrelated database.
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
      EXECUTE 'DROP SCHEMA IF EXISTS drizzle CASCADE';
    END
    $$;
  `);
}
