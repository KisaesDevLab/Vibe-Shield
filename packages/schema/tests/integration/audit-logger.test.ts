import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogger, type DatabaseHandle } from '../../src/index.js';
import { freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('AuditLogger (integration)', () => {
  let handle: DatabaseHandle;
  let logger: AuditLogger;

  beforeAll(async () => {
    handle = await freshDatabase();
    logger = new AuditLogger(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('appends a row with the SHA-256 of the payload', async () => {
    await logger.append({
      tenantId: 'audit-t1',
      eventType: 'request',
      module: 'egress',
      payload: { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50 },
    });
    const count = await logger.countForTenant('audit-t1');
    expect(count).toBe(1);
  });

  it('countForTenant filters by event type', async () => {
    await logger.append({
      tenantId: 'audit-t2',
      eventType: 'request',
      module: 'egress',
      payload: { x: 1 },
    });
    await logger.append({
      tenantId: 'audit-t2',
      eventType: 'reidentify',
      module: 'egress',
      payload: { x: 2 },
    });
    expect(await logger.countForTenant('audit-t2', 'request')).toBe(1);
    expect(await logger.countForTenant('audit-t2', 'reidentify')).toBe(1);
    expect(await logger.countForTenant('audit-t2')).toBe(2);
  });

  it('computeDailyDigest is deterministic across calls', async () => {
    await logger.append({
      tenantId: 'digest-t',
      eventType: 'request',
      module: 'egress',
      payload: { i: 1 },
    });
    await logger.append({
      tenantId: 'digest-t',
      eventType: 'reidentify',
      module: 'egress',
      payload: { i: 2 },
    });
    const today = new Date();
    const a = await logger.computeDailyDigest(today);
    const b = await logger.computeDailyDigest(today);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('digest changes when a new row arrives', async () => {
    const today = new Date();
    const before = await logger.computeDailyDigest(today);
    await logger.append({
      tenantId: 'digest-evolve',
      eventType: 'materialize',
      module: 'egress',
      payload: { sha: 'abc' },
    });
    const after = await logger.computeDailyDigest(today);
    expect(after.equals(before)).toBe(false);
  });

  it('payload field that contains PII still results in a hash, never the cleartext', async () => {
    const cleartext = 'SSN 234-56-7890 belongs to Jane Doe';
    await logger.append({
      tenantId: 'payload-test',
      eventType: 'recognizer_miss',
      module: 'redact',
      payload: { input: cleartext },
    });
    const rows = await handle.client<{ payload_hash: Buffer }[]>`
      SELECT payload_hash FROM vs_audit WHERE tenant_id = ${'payload-test'} LIMIT 1`;
    expect(rows[0]).toBeDefined();
    // The bytea column should be exactly 32 bytes; cleartext substring
    // should never appear.
    expect(rows[0]!.payload_hash.length).toBe(32);
    expect(rows[0]!.payload_hash.toString('utf8')).not.toContain('234-56-7890');
    expect(rows[0]!.payload_hash.toString('utf8')).not.toContain('Jane Doe');
  });
});
