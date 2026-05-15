import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DatabaseHandle } from '../../src/db/index.js';
import { SessionManager } from '../../src/vault/session-manager.js';
import {
  SessionUnavailableError,
  TokenVault,
} from '../../src/vault/token-vault.js';
import { freshDatabase, integrationEnabled, StaticKeyResolver } from './setup.js';

describe.skipIf(!integrationEnabled)('TokenVault (integration)', () => {
  let handle: DatabaseHandle;
  let mgr: SessionManager;
  let vault: TokenVault;
  let keys: StaticKeyResolver;

  beforeAll(async () => {
    handle = await freshDatabase();
    mgr = new SessionManager(handle.db);
    keys = new StaticKeyResolver();
    vault = new TokenVault(handle.db, keys);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('allocates <ENTITY_1> on first call', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    const result = await vault.allocate(session.id, 'EMAIL_ADDRESS', 'jane.doe@example.com');
    expect(result.token).toBe('<EMAIL_ADDRESS_1>');
    expect(result.reused).toBe(false);
  });

  it('returns the same token for the same cleartext within a session (idempotency)', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    const first = await vault.allocate(session.id, 'US_SSN', '234-56-7890');
    const second = await vault.allocate(session.id, 'US_SSN', '234-56-7890');
    expect(first.token).toBe(second.token);
    expect(second.reused).toBe(true);
  });

  it('allocates monotonic N within (session, entity_type)', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    const a = await vault.allocate(session.id, 'PERSON', 'Jane Doe');
    const b = await vault.allocate(session.id, 'PERSON', 'John Smith');
    const c = await vault.allocate(session.id, 'PERSON', 'Maria Garcia');
    expect(a.token).toBe('<PERSON_1>');
    expect(b.token).toBe('<PERSON_2>');
    expect(c.token).toBe('<PERSON_3>');
  });

  it('keeps token counters separate per entity_type', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    const ssn = await vault.allocate(session.id, 'US_SSN', '111-22-3333');
    const email = await vault.allocate(session.id, 'EMAIL_ADDRESS', 'a@b.com');
    expect(ssn.token).toBe('<US_SSN_1>');
    expect(email.token).toBe('<EMAIL_ADDRESS_1>');
  });

  it('cross-session: same cleartext gets different tokens (privacy property)', async () => {
    const sessionA = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    const sessionB = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    await vault.allocate(sessionA.id, 'US_EIN', '12-3456789');
    await vault.allocate(sessionB.id, 'US_EIN', '12-3456789');
    // Tokens may have the same N (e.g., both _1 if first in their respective
    // sessions), but the underlying hash differs — they cannot be linked
    // through vs_token_index.
    const hashA = await handle.client<{ hash: Buffer }[]>`
      SELECT hash FROM vs_token_index WHERE session_id = ${sessionA.id}::uuid LIMIT 1`;
    const hashB = await handle.client<{ hash: Buffer }[]>`
      SELECT hash FROM vs_token_index WHERE session_id = ${sessionB.id}::uuid LIMIT 1`;
    expect(hashA[0]?.hash.equals(hashB[0]!.hash)).toBe(false);
  });

  it('cross-tenant: same cleartext gets distinct dedup hashes', async () => {
    const sessionT1 = await mgr.create({ tenantId: 'tenant-A', appId: 'mybooks', userId: 'a' });
    const sessionT2 = await mgr.create({ tenantId: 'tenant-B', appId: 'mybooks', userId: 'b' });
    await vault.allocate(sessionT1.id, 'EMAIL_ADDRESS', 'shared@example.com');
    await vault.allocate(sessionT2.id, 'EMAIL_ADDRESS', 'shared@example.com');
    const rows = await handle.client<{ hash: Buffer; session_id: string }[]>`
      SELECT hash, session_id::text FROM vs_token_index
      WHERE session_id IN (${sessionT1.id}::uuid, ${sessionT2.id}::uuid)`;
    const hashByTenant = new Map(rows.map((r) => [r.session_id, r.hash]));
    expect(hashByTenant.get(sessionT1.id)?.equals(hashByTenant.get(sessionT2.id)!)).toBe(false);
  });

  it('resolve() returns the original cleartext for an allocated token', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    const original = 'Contact: jane.doe@example.com';
    const { token } = await vault.allocate(session.id, 'EMAIL_ADDRESS', original);
    expect(await vault.resolve(session.id, token)).toBe(original);
  });

  it('resolve() returns null for an unknown token', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    expect(await vault.resolve(session.id, '<HALLUCINATED_99>')).toBeNull();
  });

  it('allocate() refuses an expired session', async () => {
    const session = await mgr.create({
      tenantId: 't1',
      appId: 'mybooks',
      userId: 'alice',
      ttlMinutes: 1,
    });
    await handle.client`UPDATE vs_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${session.id}`;
    await expect(
      vault.allocate(session.id, 'US_SSN', '234-56-7890'),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
  });

  it('allocate() refuses a missing session', async () => {
    await expect(
      vault.allocate('00000000-0000-0000-0000-000000000000', 'US_SSN', 'x'),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
  });

  it('vs_audit trigger rejects UPDATE', async () => {
    await handle.client`
      INSERT INTO vs_audit (tenant_id, event_type, payload_hash)
      VALUES ('t1', 'redact', decode('00112233', 'hex'))`;
    await expect(
      handle.client`UPDATE vs_audit SET event_type = 'tampered' WHERE tenant_id = 't1'`,
    ).rejects.toThrow(/append-only/i);
  });

  it('vs_audit trigger rejects DELETE', async () => {
    await expect(
      handle.client`DELETE FROM vs_audit WHERE tenant_id = 't1'`,
    ).rejects.toThrow(/append-only/i);
  });
});
