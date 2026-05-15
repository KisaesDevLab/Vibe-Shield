/**
 * Schema smoke tests.
 *
 * Real DB integration tests live in Phase 6 alongside the TokenVault.
 * Here we verify that the Drizzle definitions export cleanly, that
 * inferred types are usable, and that every BUILD_PLAN §5 table is
 * present in the package surface.
 */

import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

describe('schema exports', () => {
  it('exports every BUILD_PLAN §5 table plus tenant_keys', () => {
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        'sessions',
        'tokens',
        'tokenIndex',
        'policies',
        'audit',
        'recognizerMisses',
        'tenantKeys',
      ]),
    );
  });

  it('Drizzle table objects have a string symbol name', () => {
    // Drizzle tables expose their SQL name via the Symbol("drizzle:Name").
    const drizzleName = Object.getOwnPropertySymbols(schema.sessions).find(
      (s) => s.toString() === 'Symbol(drizzle:Name)',
    );
    expect(drizzleName).toBeDefined();
  });

  it('NewSession type permits the documented insert shape', () => {
    // Type-level assertion: an object matching the insert shape compiles.
    const sample: schema.NewSession = {
      tenantId: 'acme',
      appId: 'mybooks',
      userId: 'alice',
      expiresAt: new Date(),
    };
    expect(sample.tenantId).toBe('acme');
  });

  it('NewAuditEvent permits payloadHash as Buffer', () => {
    const sample: schema.NewAuditEvent = {
      tenantId: 'acme',
      eventType: 'redact',
      payloadHash: Buffer.from([0, 1, 2]),
    };
    expect(sample.payloadHash.length).toBe(3);
  });

  it('NewTenantKey requires wrappedDek as Buffer', () => {
    const sample: schema.NewTenantKey = {
      tenantId: 'acme',
      wrappedDek: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    };
    expect(sample.wrappedDek.length).toBe(4);
  });
});
