import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import {
  createWrappedDek,
  type DatabaseHandle,
  formatKekForEnv,
  newKey,
  tenantKeys,
  unwrapDek,
} from '../../src/index.js';
import { freshDatabase, integrationEnabled } from './setup.js';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/rotate-kek.ts', ...args],
      { env: { ...process.env, ...env }, cwd: process.cwd() },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!integrationEnabled)('rotate-kek script (integration)', () => {
  let handle: DatabaseHandle;
  let oldKek: Buffer;
  let newKek: Buffer;
  const tenant = 'rotate-test';

  beforeAll(async () => {
    handle = await freshDatabase();
    oldKek = newKey();
    newKek = newKey();
    const wrap = createWrappedDek(oldKek, tenant);
    await handle.db.insert(tenantKeys).values({
      tenantId: tenant,
      wrappedDek: wrap.wrappedDek,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('refuses without --dry-run or --apply', async () => {
    const r = await runScript([], {
      OLD_VS_KEK: formatKekForEnv(oldKek),
      NEW_VS_KEK: formatKekForEnv(newKek),
      DATABASE_URL: process.env['DATABASE_URL']!,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--dry-run');
  });

  it('--dry-run reports unwrappable count without writing', async () => {
    const r = await runScript(['--dry-run'], {
      OLD_VS_KEK: formatKekForEnv(oldKek),
      NEW_VS_KEK: formatKekForEnv(newKek),
      DATABASE_URL: process.env['DATABASE_URL']!,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Dry-run summary');
    // Confirm wrappedDek is unchanged after dry-run.
    const rows = await handle.db
      .select()
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenant));
    const dek = unwrapDek(rows[0]!.wrappedDek, oldKek, tenant);
    expect(dek.length).toBe(32);
  });

  it('--dry-run with wrong OLD_VS_KEK fails with code 2', async () => {
    const wrongKek = newKey();
    const r = await runScript(['--dry-run'], {
      OLD_VS_KEK: formatKekForEnv(wrongKek),
      NEW_VS_KEK: formatKekForEnv(newKek),
      DATABASE_URL: process.env['DATABASE_URL']!,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot unwrap');
  });

  it('--apply re-wraps every tenant DEK under the new KEK', async () => {
    const r = await runScript(['--apply'], {
      OLD_VS_KEK: formatKekForEnv(oldKek),
      NEW_VS_KEK: formatKekForEnv(newKek),
      DATABASE_URL: process.env['DATABASE_URL']!,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Applied');
    const rows = await handle.db
      .select()
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenant));
    // Old KEK should no longer unwrap.
    expect(() => unwrapDek(rows[0]!.wrappedDek, oldKek, tenant)).toThrow();
    // New KEK should unwrap.
    const dek = unwrapDek(rows[0]!.wrappedDek, newKek, tenant);
    expect(dek.length).toBe(32);
    // rotated_at populated.
    expect(rows[0]!.rotatedAt).not.toBeNull();
  });

  it('rejects --dry-run + --apply together', async () => {
    const r = await runScript(['--dry-run', '--apply'], {
      OLD_VS_KEK: formatKekForEnv(oldKek),
      NEW_VS_KEK: formatKekForEnv(newKek),
      DATABASE_URL: process.env['DATABASE_URL']!,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('mutually exclusive');
  });
});
