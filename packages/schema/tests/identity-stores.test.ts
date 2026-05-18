/**
 * Unit tests for the Phase 24 identity stores that don't need a DB.
 *
 * Round-trip + format guarantees of the token helpers + role ranking.
 * Integration tests for the actual store methods live in
 * tests/integration/identity-stores.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  generateMagicLinkToken,
  generateSessionToken,
  hashMagicLinkToken,
  hashSessionToken,
} from '../src/vault/index.js';
import { roleSatisfies } from '../src/vault/user-store.js';

describe('magic-link token format', () => {
  it('produces URL-safe base64 of 32 bytes (43 chars)', () => {
    for (let i = 0; i < 50; i++) {
      const tok = generateMagicLinkToken();
      expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashToken is deterministic and 32 bytes', () => {
    const tok = 'abc-xyz_12345-67890';
    const h1 = hashMagicLinkToken(tok);
    const h2 = hashMagicLinkToken(tok);
    expect(h1.equals(h2)).toBe(true);
    expect(h1.length).toBe(32);
  });

  it('different tokens hash to different digests', () => {
    const a = hashMagicLinkToken('one');
    const b = hashMagicLinkToken('two');
    expect(a.equals(b)).toBe(false);
  });
});

describe('session token format', () => {
  it('produces URL-safe base64 of 32 bytes (43 chars)', () => {
    for (let i = 0; i < 50; i++) {
      const tok = generateSessionToken();
      expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashSessionToken is deterministic and 32 bytes', () => {
    const tok = 'session-token-value';
    expect(hashSessionToken(tok).length).toBe(32);
    expect(hashSessionToken(tok).equals(hashSessionToken(tok))).toBe(true);
  });
});

describe('roleSatisfies', () => {
  it('admin satisfies every minimum', () => {
    expect(roleSatisfies('admin', 'viewer')).toBe(true);
    expect(roleSatisfies('admin', 'operator')).toBe(true);
    expect(roleSatisfies('admin', 'admin')).toBe(true);
  });

  it('operator satisfies viewer + operator, not admin', () => {
    expect(roleSatisfies('operator', 'viewer')).toBe(true);
    expect(roleSatisfies('operator', 'operator')).toBe(true);
    expect(roleSatisfies('operator', 'admin')).toBe(false);
  });

  it('viewer satisfies only viewer', () => {
    expect(roleSatisfies('viewer', 'viewer')).toBe(true);
    expect(roleSatisfies('viewer', 'operator')).toBe(false);
    expect(roleSatisfies('viewer', 'admin')).toBe(false);
  });
});
