import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import {
  PRICING,
  SpendCapExceededError,
  SpendTracker,
  priceFor,
} from '../src/quota/spend-cap.js';
import { freshDatabase, integrationEnabled } from './setup.js';

describe('priceFor', () => {
  it('computes Sonnet 4.6 input cost correctly', () => {
    // 1M input tokens of Sonnet at $3/Mtok = 3,000,000 microdollars.
    expect(priceFor('claude-sonnet-4-6', 1_000_000, 0)).toBe(3_000_000n);
  });

  it('computes Sonnet 4.6 output cost correctly', () => {
    expect(priceFor('claude-sonnet-4-6', 0, 1_000_000)).toBe(15_000_000n);
  });

  it('falls back to a conservative price for unknown models', () => {
    const cost = priceFor('unknown-future-model', 1_000_000, 1_000_000);
    expect(cost).toBeGreaterThan(0n);
  });

  it('PRICING table covers every Vibe-known model', () => {
    expect(PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING['claude-opus-4-7']).toBeDefined();
    expect(PRICING['claude-haiku-4-5-20251001']).toBeDefined();
  });
});

describe.skipIf(!integrationEnabled)('SpendTracker (integration)', () => {
  let handle: DatabaseHandle;
  let tracker: SpendTracker;

  beforeAll(async () => {
    handle = await freshDatabase();
    tracker = new SpendTracker({
      db: handle.db,
      defaultCapMicrodollars: 100_000_000n, // $100/mo for testing
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('records and reads back current month spend', async () => {
    await tracker.record({
      tenantId: 'spend-test',
      appId: 'mybooks',
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    const spend = await tracker.currentMonthSpend('spend-test');
    // 1M input × $3 + 0.5M output × $15 = 3M + 7.5M = 10.5M microdollars.
    expect(spend).toBe(10_500_000n);
  });

  it('checkCap throws when over the cap', async () => {
    // Push spend over $100 cap.
    for (let i = 0; i < 12; i++) {
      await tracker.record({
        tenantId: 'cap-breach',
        appId: 'mybooks',
        model: 'claude-opus-4-7',
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
    }
    // Now at 12 × $15 = $180. Cap is $100.
    await expect(tracker.checkCap('cap-breach')).rejects.toBeInstanceOf(
      SpendCapExceededError,
    );
  });

  it('checkCap passes for tenants under the cap', async () => {
    await tracker.checkCap('completely-fresh-tenant');
  });

  it('isolates tenants', async () => {
    // 'cap-breach' is over; a different tenant should be fine.
    await tracker.checkCap('untouched-tenant');
  });
});
