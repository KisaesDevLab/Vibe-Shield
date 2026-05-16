#!/usr/bin/env node
/**
 * Daily audit-digest writer (v1.1 §3.4).
 *
 * Computes the SHA-256 hash-chained digest of every vs_audit row for
 * a given UTC date and writes it to
 * ``compliance/audit-digests/<YYYY-MM-DD>.txt``.
 *
 * Run via cron at 00:05 UTC for the *previous* day:
 *   0 5 0 * * *   /usr/local/bin/node /app/packages/schema/dist/scripts/write-audit-digest.js
 *
 * Manual back-fill:
 *   node packages/schema/dist/scripts/write-audit-digest.js --date 2026-05-15
 *
 * The output file is the tamper-evidence record the WISP +
 * incident-response runbook reference. Never overwrites an existing
 * file (would defeat tamper evidence) — it errors instead.
 *
 * Env: DATABASE_URL is required. AUDIT_DIGEST_DIR defaults to
 * ``compliance/audit-digests`` relative to cwd; override for the
 * appliance volume mount.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDatabase } from '../src/db/index.js';
import { AuditLogger } from '../src/vault/audit-logger.js';

interface ParsedArgs {
  date: Date;
  dir: string;
  force: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let date = yesterdayUtc();
  let dir = process.env['AUDIT_DIGEST_DIR'] ?? 'compliance/audit-digests';
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--date') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--date requires YYYY-MM-DD');
      date = parseUtcDate(value);
    } else if (arg === '--dir') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--dir requires a path');
      dir = value;
    } else if (arg === '--force') {
      // Allowed only for back-fill in dry-run scenarios. Production
      // runs MUST NOT pass --force; an existing file means the digest
      // was already computed, and overwriting destroys tamper
      // evidence. The CHANGELOG records this as an operator escape
      // hatch with no policy backing.
      force = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { date, dir, force };
}

function yesterdayUtc(): Date {
  const now = new Date();
  const utc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
  );
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc;
}

function parseUtcDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date ${s}; expected YYYY-MM-DD`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL env var required');
  }
  const args = parseArgs(process.argv.slice(2));
  const dateStr = formatDate(args.date);
  const outDir = resolve(args.dir);
  const outPath = resolve(outDir, `${dateStr}.txt`);

  if (existsSync(outPath) && !args.force) {
     
    console.error(
      `audit digest for ${dateStr} already exists at ${outPath}; refusing to overwrite (use --force to override; not recommended)`,
    );
    process.exit(2);
  }

  const handle = createDatabase(url, { max: 2 });
  try {
    const logger = new AuditLogger(handle.db);
    const digest = await logger.computeDailyDigest(args.date);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    const body = `# Vibe Shield audit digest\n# date: ${dateStr}\n# generator: v1.1 §3.4\n${digest.toString('hex')}\n`;
    writeFileSync(outPath, body, { encoding: 'utf8', mode: 0o440, flag: 'wx' });
     
    console.error(`wrote ${outPath} (${digest.length} bytes)`);
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
   
  console.error(`write-audit-digest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
