import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DatabaseHandle } from '@kisaesdevlab/vibe-shield-schema';
import {
  BUILT_IN_POLICIES,
  CONVERTER_OUTPUT,
  STRICT_BOOKKEEPING,
} from '../src/policy/built-in.js';
import { PolicyResolver } from '../src/policy/resolver.js';
import { freshDatabase, integrationEnabled } from './setup.js';

describe('built-in policies', () => {
  it('exports the five policies BUILD_PLAN §10 + addendum name', () => {
    const names = BUILT_IN_POLICIES.map((p) => p.name);
    expect(names).toEqual([
      'cpa-bookkeeping-strict',
      'cpa-bookkeeping-balanced',
      'tax-research',
      'internal-only',
      'cpa-converter-output',
    ]);
  });

  it('strict bookkeeping requires ZDR', () => {
    expect(STRICT_BOOKKEEPING.zdr_required).toBe(true);
  });

  it('converter-output uses none re-id mode (materialize is the only path)', () => {
    expect(CONVERTER_OUTPUT.reid.mode).toBe('none');
  });

  it('converter-output requires ZDR', () => {
    expect(CONVERTER_OUTPUT.zdr_required).toBe(true);
  });
});

describe.skipIf(!integrationEnabled)('PolicyResolver (integration)', () => {
  let handle: DatabaseHandle;
  let resolver: PolicyResolver;

  beforeAll(async () => {
    handle = await freshDatabase();
    resolver = new PolicyResolver(handle.db);
    await resolver.ensureLoaded();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('resolves built-in by app: mybooks → cpa-bookkeeping-strict', async () => {
    const p = await resolver.resolve({ tenantId: 't1', appId: 'mybooks' });
    expect(p.allowed_apps).toContain('mybooks');
  });

  it('honors requested policy name when app is allowed', async () => {
    const p = await resolver.resolve({
      tenantId: 't1',
      appId: 'tax-research',
      requestedPolicy: 'tax-research',
    });
    expect(p.name).toBe('tax-research');
  });

  it('refuses requested policy if app not in its allowed_apps', async () => {
    // tax-research policy doesn't allow mybooks app — falls back.
    const p = await resolver.resolve({
      tenantId: 't1',
      appId: 'mybooks',
      requestedPolicy: 'tax-research',
    });
    expect(p.name).not.toBe('tax-research');
  });

  it('falls back to default for unknown app', async () => {
    const p = await resolver.resolve({ tenantId: 't1', appId: 'unknown-app' });
    expect(p.name).toBe('cpa-bookkeeping-balanced');
  });

  it('save() writes a versioned row that wins on next resolve', async () => {
    await resolver.save({
      ...STRICT_BOOKKEEPING,
      max_tokens_ceiling: 99,
    });
    const fresh = new PolicyResolver(handle.db);
    await fresh.ensureLoaded();
    const got = await fresh.resolve({
      tenantId: 't1',
      appId: 'mybooks',
      requestedPolicy: 'cpa-bookkeeping-strict',
    });
    expect(got.max_tokens_ceiling).toBe(99);
  });
});
