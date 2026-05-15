/**
 * 100+ redact → re-identify roundtrip cases.
 *
 * BUILD_PLAN §6: "Tests: 100+ round-trip redact → re-identify cases".
 * For each case we generate a synthetic cleartext, allocate a token in
 * a fresh session, and assert that ``resolve(sessionId, token)`` returns
 * the original cleartext byte-for-byte.
 *
 * The matrix mixes entity types, character classes, lengths, and edge
 * cases (empty-ish strings, unicode, embedded newlines). The dataset
 * is deterministic so any failure points at a specific case.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DatabaseHandle } from '../../src/db/index.js';
import { SessionManager } from '../../src/vault/session-manager.js';
import { TokenVault } from '../../src/vault/token-vault.js';
import { freshDatabase, integrationEnabled, StaticKeyResolver } from './setup.js';

interface Case {
  entityType: string;
  cleartext: string;
}

function generateCases(): Case[] {
  const cases: Case[] = [];

  // 25 fake-but-format-valid SSNs in non-issued ranges.
  for (let i = 0; i < 25; i++) {
    const a = (200 + i).toString().padStart(3, '0');
    const b = (10 + i).toString().padStart(2, '0');
    const c = (1000 + i).toString().padStart(4, '0');
    cases.push({ entityType: 'US_SSN', cleartext: `${a}-${b}-${c}` });
  }

  // 25 fake EINs across valid IRS prefixes.
  const validPrefixes = ['12', '27', '38', '45', '52', '64', '76', '81', '94', '99'];
  for (let i = 0; i < 25; i++) {
    const prefix = validPrefixes[i % validPrefixes.length]!;
    const tail = (1_000_000 + i).toString();
    cases.push({ entityType: 'US_EIN', cleartext: `${prefix}-${tail}` });
  }

  // 25 fake emails across local-part / domain shapes.
  const locals = [
    'jane.doe',
    'bookkeeper.monthly',
    'tax-team',
    'audit',
    'ops',
    'support+ticket',
    'first.last',
    'a-b-c',
    'PORTAL.ADMIN',
    'numeric.1234',
  ];
  const domains = ['example.com', 'firm.example.com', 'sub.example.org', 'kisaes.dev'];
  for (let i = 0; i < 25; i++) {
    const local = locals[i % locals.length]!;
    const domain = domains[i % domains.length]!;
    cases.push({ entityType: 'EMAIL_ADDRESS', cleartext: `${local}${i.toString()}@${domain}` });
  }

  // 25 fake person names (Faker-style synthetic).
  const firsts = ['Jane', 'John', 'Maria', 'Yusuf', 'Olivia', 'Robert', 'Aisha', 'Wei', 'Carlos', 'Priya'];
  const lasts = ['Doe', 'Smith', 'Garcia', 'Patel', 'Chen', 'Kim', 'Nguyen', 'Hernandez', 'Okafor', 'Rossi'];
  for (let i = 0; i < 25; i++) {
    const first = firsts[i % firsts.length]!;
    const last = lasts[(i * 7) % lasts.length]!;
    cases.push({ entityType: 'PERSON', cleartext: `${first} ${last}` });
  }

  // 10 boundary / edge cases: empty-ish, whitespace, unicode, newlines.
  cases.push(
    { entityType: 'NOTE', cleartext: 'a' },
    { entityType: 'NOTE', cleartext: 'a b c' },
    { entityType: 'NOTE', cleartext: '  spaced  ' },
    { entityType: 'NOTE', cleartext: 'tab\there' },
    { entityType: 'NOTE', cleartext: 'multi\nline\nstring' },
    { entityType: 'NOTE', cleartext: 'naïve résumé café' },
    { entityType: 'NOTE', cleartext: '日本語テスト' },
    { entityType: 'NOTE', cleartext: '🔐 emoji ✅' },
    { entityType: 'NOTE', cleartext: 'quote "inside" string' },
    { entityType: 'NOTE', cleartext: 'long string ' + 'x'.repeat(2048) },
  );

  return cases;
}

const CASES = generateCases();

describe.skipIf(!integrationEnabled)('100+ roundtrip redact → re-identify', () => {
  let handle: DatabaseHandle;
  let mgr: SessionManager;
  let vault: TokenVault;

  beforeAll(async () => {
    handle = await freshDatabase();
    mgr = new SessionManager(handle.db);
    vault = new TokenVault(handle.db, new StaticKeyResolver());
  });

  afterAll(async () => {
    await handle.close();
  });

  it('case set has at least 100 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });

  it.each(CASES.map((c, idx) => [idx, c.entityType, c.cleartext] as const))(
    'roundtrip[%i] %s',
    async (_idx, entityType, cleartext) => {
      const session = await mgr.create({
        tenantId: 'roundtrip',
        appId: 'mybooks',
        userId: 'alice',
      });
      const { token } = await vault.allocate(session.id, entityType, cleartext);
      expect(token.startsWith(`<${entityType}_`)).toBe(true);
      expect(token.endsWith('>')).toBe(true);

      const resolved = await vault.resolve(session.id, token);
      expect(resolved).toBe(cleartext);

      // Idempotency: a second allocate returns the same token, marked reused.
      const second = await vault.allocate(session.id, entityType, cleartext);
      expect(second.token).toBe(token);
      expect(second.reused).toBe(true);
    },
  );
});
