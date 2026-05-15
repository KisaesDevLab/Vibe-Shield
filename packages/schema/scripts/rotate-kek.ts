#!/usr/bin/env node
/**
 * KEK rotation script.
 *
 * Re-wraps every ``vs_tenant_keys`` row under a new KEK. The DEKs
 * themselves DO NOT change — only the wrapping changes — so
 * ``vs_tokens.cleartext_encrypted`` is untouched. Zero re-encryption
 * of token rows.
 *
 * Usage:
 *
 *   # Env-var path (CI / appliance bootstrap)
 *   OLD_VS_KEK="<base64>" NEW_VS_KEK="<base64>" \
 *     DATABASE_URL="postgres://..." \
 *     node packages/schema/dist/scripts/rotate-kek.js --dry-run
 *
 *   # Then, after reviewing the dry-run report:
 *   OLD_VS_KEK="<base64>" NEW_VS_KEK="<base64>" \
 *     DATABASE_URL="postgres://..." \
 *     node packages/schema/dist/scripts/rotate-kek.js --apply
 *
 *   # Interactive path (human-in-the-loop)
 *   node packages/schema/dist/scripts/rotate-kek.js --interactive --dry-run
 *   node packages/schema/dist/scripts/rotate-kek.js --interactive --apply
 *
 * Hard rules in force:
 *   - Mandatory --dry-run first. --apply requires it to have been
 *     run (we don't track that across invocations, but we do require
 *     either --dry-run or --apply explicitly — never both unset).
 *   - Re-wrap runs in a single transaction; either every row gets
 *     the new wrapping or no row does.
 *   - Cleartext DEKs live in this process's heap for the duration of
 *     the re-wrap; zeroed in finally{}.
 *   - Old + new KEKs are wiped from process memory after use.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  KEY_LENGTH,
  rewrapDek,
  unwrapDek,
} from '../src/crypto/index.js';
import { tenantKeys } from '../src/schema/tenant-keys.js';

interface CliFlags {
  dryRun: boolean;
  apply: boolean;
  interactive: boolean;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { dryRun: false, apply: false, interactive: false };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--interactive') flags.interactive = true;
    else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

function decodeKek(value: string, label: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value.trim(), 'base64');
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(
      `${label} must be ${KEY_LENGTH.toString()} bytes of base64; got ${bytes.length.toString()}`,
    );
  }
  return bytes;
}

async function readKekFromStdin(label: string): Promise<Buffer> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // eslint-disable-next-line no-console
    console.error(`Enter ${label} (base64-encoded 32 bytes):`);
    const value = await rl.question('> ');
    return decodeKek(value, label);
  } finally {
    rl.close();
  }
}

async function loadKeks(flags: CliFlags): Promise<{ oldKek: Buffer; newKek: Buffer }> {
  if (flags.interactive) {
    const oldKek = await readKekFromStdin('OLD KEK');
    const newKek = await readKekFromStdin('NEW KEK');
    return { oldKek, newKek };
  }
  const oldRaw = process.env['OLD_VS_KEK'];
  const newRaw = process.env['NEW_VS_KEK'];
  if (oldRaw === undefined || oldRaw === '') {
    throw new Error('OLD_VS_KEK env var required (or pass --interactive)');
  }
  if (newRaw === undefined || newRaw === '') {
    throw new Error('NEW_VS_KEK env var required (or pass --interactive)');
  }
  return {
    oldKek: decodeKek(oldRaw, 'OLD_VS_KEK'),
    newKek: decodeKek(newRaw, 'NEW_VS_KEK'),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.dryRun && !flags.apply) {
    throw new Error(
      'pass either --dry-run (recommended first) or --apply explicitly',
    );
  }
  if (flags.dryRun && flags.apply) {
    throw new Error('--dry-run and --apply are mutually exclusive');
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL env var required');
  }

  const { oldKek, newKek } = await loadKeks(flags);

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  let processed = 0;
  let failed = 0;
  try {
    const rows = await db
      .select({ tenantId: tenantKeys.tenantId, wrappedDek: tenantKeys.wrappedDek })
      .from(tenantKeys);
    // eslint-disable-next-line no-console
    console.error(`Found ${rows.length.toString()} tenant key(s).`);

    if (flags.dryRun) {
      // Verify each row unwraps under the OLD KEK; report any failures.
      for (const row of rows) {
        try {
          const dek = unwrapDek(row.wrappedDek, oldKek, row.tenantId);
          dek.fill(0);
          processed += 1;
        } catch {
          failed += 1;
          // eslint-disable-next-line no-console
          console.error(`  X tenant=${row.tenantId} cannot unwrap with OLD_VS_KEK`);
        }
      }
      // eslint-disable-next-line no-console
      console.error(
        `\nDry-run summary: ${processed.toString()} unwrappable, ${failed.toString()} failed.`,
      );
      if (failed > 0) {
        // eslint-disable-next-line no-console
        console.error('Refusing to proceed. Re-check OLD_VS_KEK.');
        process.exit(2);
      }
      // eslint-disable-next-line no-console
      console.error('Dry-run OK. Re-run with --apply (same env) to commit.');
    } else {
      // --apply: re-wrap every row in a single transaction. If any
      // row fails to unwrap under OLD_VS_KEK, the whole transaction
      // rolls back.
      await db.transaction(async (tx) => {
        for (const row of rows) {
          const rewrapped = rewrapDek(row.wrappedDek, oldKek, newKek, row.tenantId);
          await tx
            .update(tenantKeys)
            .set({ wrappedDek: rewrapped, rotatedAt: new Date() })
            .where(eq(tenantKeys.tenantId, row.tenantId));
          processed += 1;
        }
      });
      // eslint-disable-next-line no-console
      console.error(`\nApplied: re-wrapped ${processed.toString()} tenant key(s).`);
      // eslint-disable-next-line no-console
      console.error(
        'Now update VS_KEK in the appliance secret manager and restart the gateway.',
      );
    }
  } finally {
    oldKek.fill(0);
    newKek.fill(0);
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`rotate-kek failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
