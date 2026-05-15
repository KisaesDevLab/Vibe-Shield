import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SessionExpiredError,
  SessionManager,
  SessionNotFoundError,
} from '../../src/vault/session-manager.js';
import { type DatabaseHandle } from '../../src/db/index.js';
import { freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('SessionManager (integration)', () => {
  let handle: DatabaseHandle;
  let mgr: SessionManager;

  beforeAll(async () => {
    handle = await freshDatabase();
    mgr = new SessionManager(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('creates a session with default 60-minute TTL', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    const ttlMs = session.expiresAt.getTime() - session.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(59 * 60_000);
    expect(ttlMs).toBeLessThan(61 * 60_000);
  });

  it('respects custom TTL', async () => {
    const session = await mgr.create({
      tenantId: 't1',
      appId: 'mybooks',
      userId: 'alice',
      ttlMinutes: 5,
    });
    const ttlMs = session.expiresAt.getTime() - session.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(4 * 60_000);
    expect(ttlMs).toBeLessThan(6 * 60_000);
  });

  it('get() returns null for missing session', async () => {
    const ghost = '00000000-0000-0000-0000-000000000000';
    expect(await mgr.get(ghost)).toBeNull();
  });

  it('get() throws SessionExpiredError for expired session', async () => {
    const session = await mgr.create({
      tenantId: 't1',
      appId: 'mybooks',
      userId: 'alice',
      ttlMinutes: 1,
    });
    // Force expiry by hand.
    await handle.client`UPDATE vs_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${session.id}`;
    await expect(mgr.get(session.id)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('touch() bumps expiry forward', async () => {
    const session = await mgr.create({
      tenantId: 't1',
      appId: 'mybooks',
      userId: 'alice',
      ttlMinutes: 5,
    });
    const original = session.expiresAt.getTime();
    await new Promise((r) => setTimeout(r, 50));
    const touched = await mgr.touch(session.id, 30);
    expect(touched.expiresAt.getTime()).toBeGreaterThan(original);
  });

  it('touch() throws SessionNotFoundError for missing session', async () => {
    await expect(mgr.touch('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('delete() removes the session', async () => {
    const session = await mgr.create({ tenantId: 't1', appId: 'mybooks', userId: 'alice' });
    await mgr.delete(session.id);
    expect(await mgr.get(session.id)).toBeNull();
  });

  it('purgeExpired() removes only expired sessions', async () => {
    const live = await mgr.create({
      tenantId: 'gc-test',
      appId: 'mybooks',
      userId: 'alice',
      ttlMinutes: 60,
    });
    const dead = await mgr.create({
      tenantId: 'gc-test',
      appId: 'mybooks',
      userId: 'alice',
      ttlMinutes: 1,
    });
    await handle.client`UPDATE vs_sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${dead.id}`;
    const purged = await mgr.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await mgr.get(dead.id)).toBeNull();
    const liveRecord = await mgr.get(live.id);
    expect(liveRecord?.id).toBe(live.id);
  });

  it('countActive() reflects only non-expired sessions', async () => {
    const tenant = `count-test-${Date.now().toString()}`;
    await mgr.create({ tenantId: tenant, appId: 'mybooks', userId: 'alice' });
    await mgr.create({ tenantId: tenant, appId: 'mybooks', userId: 'bob' });
    expect(await mgr.countActive(tenant)).toBe(2);
  });
});
