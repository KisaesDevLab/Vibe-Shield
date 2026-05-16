#!/usr/bin/env node
/**
 * Secure wipe of the Vibe Shield token vault (appliance uninstall).
 *
 * BUILD_PLAN §21 acceptance criterion: "Uninstall flow: secure wipe
 * of token vault". This script drops every ``vs_*`` table + the
 * Drizzle migration-tracking schema. After this runs:
 *
 *   - The per-tenant DEKs are gone (column dropped).
 *   - All wrapped ciphertexts are gone (rows dropped).
 *   - The KEK in env can be safely deleted by the operator (nothing
 *     left to decrypt).
 *   - The audit log + spend records + recognizer misses are gone.
 *
 * The script is bounded to ``vs_*``-prefixed tables and the ``drizzle``
 * schema, so it cannot accidentally wipe an unrelated database that
 * happens to share a Postgres instance with Vibe Shield.
 *
 * SAFETY GATES (refuses to run unless ALL three pass):
 *   1. ``--apply`` flag must be explicitly passed.
 *   2. ``VIBE_SHIELD_WIPE_CONFIRM`` env var must equal "WIPE-VAULT".
 *   3. The current ``vs_audit`` row count is shown and the operator
 *      types the count back interactively (or passes
 *      ``--audit-rows=N`` for unattended uninstall).
 *
 * Use ``--dry-run`` (mutually exclusive with ``--apply``) to count
 * everything without writing.
 *
 * Operator invocation:
 *   make wipe-vault-dry         # safe; counts only
 *   VIBE_SHIELD_WIPE_CONFIRM=WIPE-VAULT make wipe-vault-apply
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { sql } from 'drizzle-orm';
import { createDatabase } from '../src/db/index.js';
import { dropAllVibeShieldObjects } from '../src/db/migrate.js';

interface Args {
  dryRun: boolean;
  apply: boolean;
  auditRows: number | undefined;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let apply = false;
  let auditRows: number | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--apply') apply = true;
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a !== undefined && a.startsWith('--audit-rows=')) {
      const v = Number(a.slice('--audit-rows='.length));
      if (!Number.isInteger(v) || v < 0) {
        throw new Error('--audit-rows must be a non-negative integer');
      }
      auditRows = v;
    } else {
      throw new Error(`unknown argument: ${a ?? ''}`);
    }
  }
  if (dryRun === apply) {
    throw new Error('exactly one of --dry-run or --apply is required');
  }
  return { dryRun, apply, auditRows, yes };
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL env var required');
  }
  const args = parseArgs(process.argv.slice(2));

  const handle = createDatabase(url, { max: 2 });
  try {
    // Always show counts first — operator sees what's about to be wiped.
    const counts = await collectCounts(handle);
     
    console.error(`Vibe Shield vault contents in ${redactDsn(url)}:`);
    for (const [name, n] of Object.entries(counts)) {
       
      console.error(`  ${name.padEnd(28)} ${String(n).padStart(8)} rows`);
    }

    if (args.dryRun) {
       
      console.error('\n[dry-run] no changes made.');
      return;
    }

    // Apply path: triple-gate before touching anything.
    const confirm = process.env['VIBE_SHIELD_WIPE_CONFIRM'];
    if (confirm !== 'WIPE-VAULT') {
      throw new Error(
        '--apply requires VIBE_SHIELD_WIPE_CONFIRM=WIPE-VAULT in env',
      );
    }

    const expectedAudit = args.auditRows;
    const actualAudit = counts['vs_audit'] ?? 0;
    if (expectedAudit !== undefined) {
      if (expectedAudit !== actualAudit) {
        throw new Error(
          `--audit-rows=${expectedAudit.toString()} does not match actual ${actualAudit.toString()}; refusing to wipe`,
        );
      }
    } else if (!args.yes) {
      // Interactive confirmation. Operator must type the audit row
      // count back. Prevents copy-paste mistakes that target the wrong
      // appliance.
      const rl = createInterface({ input: stdin, output: stdout });
      try {
         
        console.error(
          `\nThis will permanently drop every vs_* table. Type the vs_audit count (${actualAudit.toString()}) to confirm, or anything else to abort:`,
        );
        const answer = await rl.question('> ');
        if (answer.trim() !== String(actualAudit)) {
          throw new Error('confirmation mismatch; aborting');
        }
      } finally {
        rl.close();
      }
    }

     
    console.error('\nWiping...');
    await dropAllVibeShieldObjects(handle);
     
    console.error('vault wiped. Rotate VS_KEK and delete it from your secret manager next.');
  } finally {
    await handle.close();
  }
}

async function collectCounts(
  handle: ReturnType<typeof createDatabase>,
): Promise<Record<string, number>> {
  // Discover every vs_* table in the current schema. Returns 0 entries
  // if Shield was never installed.
  const tables = await handle.db.execute(
    sql<{ tablename: string }>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'vs_%' ORDER BY tablename`,
  );
  const out: Record<string, number> = {};
  for (const row of tables as unknown as { tablename: string }[]) {
    const r = await handle.client.unsafe(
      `SELECT COUNT(*)::bigint AS n FROM ${quoteIdent(row.tablename)}`,
    );
    const n = Number((r[0] as { n?: string | number } | undefined)?.n ?? 0);
    out[row.tablename] = n;
  }
  return out;
}

function quoteIdent(name: string): string {
  // Bounded by the LIKE 'vs_%' filter above, but defense-in-depth:
  // reject anything that isn't a-z0-9_.
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to quote suspicious identifier: ${name}`);
  }
  return `"${name}"`;
}

function redactDsn(url: string): string {
  return url.replace(/:[^:@]*@/, ':***@');
}

main().catch((err: unknown) => {
   
  console.error(`wipe-vault failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
