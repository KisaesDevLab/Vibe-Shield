import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RecognizerMissStore,
  type DatabaseHandle,
  recognizerMisses,
} from '../../src/index.js';
import { freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('RecognizerMissStore (integration)', () => {
  let handle: DatabaseHandle;
  let store: RecognizerMissStore;

  beforeAll(async () => {
    handle = await freshDatabase();
    store = new RecognizerMissStore(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('records a single miss and reads it back', async () => {
    await store.recordBatch([
      { pattern: 'ssn_backstop', sampleHash: 'abc123', severity: 'block' },
    ]);
    const rows = await handle.db.select().from(recognizerMisses);
    const found = rows.find((r) => r.sampleHash === 'abc123');
    expect(found).toBeDefined();
    expect(found?.pattern).toBe('ssn_backstop');
    expect(found?.severity).toBe('block');
  });

  it('records a batch of misses', async () => {
    await store.recordBatch([
      { pattern: 'ein_backstop', sampleHash: 'h1', severity: 'block' },
      { pattern: 'routing_backstop', sampleHash: 'h2', severity: 'block' },
      { pattern: 'phone_backstop', sampleHash: 'h3', severity: 'warn' },
    ]);
    const rows = await handle.db.select().from(recognizerMisses);
    const hashes = rows.map((r) => r.sampleHash);
    expect(hashes).toContain('h1');
    expect(hashes).toContain('h2');
    expect(hashes).toContain('h3');
  });

  it('no-ops on empty input', async () => {
    await store.recordBatch([]);
    // Should not throw; nothing to assert beyond reaching this point.
  });

  it('persisted sample_hash is exactly what was passed (no transformation)', async () => {
    const hash = 'deadbeefcafebabe';
    await store.recordBatch([
      { pattern: 'test_pattern', sampleHash: hash, severity: 'allow' },
    ]);
    const rows = await handle.db.select().from(recognizerMisses);
    const found = rows.find((r) => r.sampleHash === hash);
    expect(found?.sampleHash).toBe(hash);
  });
});
