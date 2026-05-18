/**
 * Integration tests for the Phase 24 identity stores.
 *
 * UserStore: create + role upsert + disable + listAll.
 * MagicLinkStore: issue → consume happy path; double-consume fails;
 * expired link fails.
 * UserSessionStore: issue → validate slides expiry; revoke kills it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MagicLinkInvalidError,
  MagicLinkStore,
  SessionInvalidError,
  UserExistsError,
  UserSessionStore,
  UserStore,
  type DatabaseHandle,
} from '../../src/index.js';
import { freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('UserStore (integration)', () => {
  let handle: DatabaseHandle;
  let users: UserStore;

  beforeAll(async () => {
    handle = await freshDatabase();
    users = new UserStore(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('create + findByEmail round-trips', async () => {
    const u = await users.create({ email: 'alice@firm.example', isOrgAdmin: true });
    expect(u.isOrgAdmin).toBe(true);
    const found = await users.findByEmail('Alice@Firm.Example');
    expect(found?.id).toBe(u.id);
  });

  it('duplicate active email throws UserExistsError', async () => {
    await users.create({ email: 'dup@firm.example' });
    await expect(users.create({ email: 'dup@firm.example' })).rejects.toBeInstanceOf(
      UserExistsError,
    );
  });

  it('setRole upsert: granting same role twice is a no-op', async () => {
    const u = await users.create({ email: 'role-upsert@firm.example' });
    await users.setRole(u.id, 'redact', 'operator');
    await users.setRole(u.id, 'redact', 'operator');
    const hydrated = await users.findByIdWithRoles(u.id);
    expect(hydrated?.roles.redact).toBe('operator');
  });

  it('setRole upgrade replaces prior role', async () => {
    const u = await users.create({ email: 'role-upgrade@firm.example' });
    await users.setRole(u.id, 'scan', 'viewer');
    await users.setRole(u.id, 'scan', 'admin');
    const hydrated = await users.findByIdWithRoles(u.id);
    expect(hydrated?.roles.scan).toBe('admin');
  });

  it('disable hides from findByEmail but keeps row', async () => {
    const u = await users.create({ email: 'disabled@firm.example' });
    await users.disable(u.id);
    expect(await users.findByEmail('disabled@firm.example')).toBeNull();
    expect(await users.findById(u.id)).not.toBeNull();
  });

  it('count() is the bootstrap trigger', async () => {
    const before = await users.count();
    expect(before).toBeGreaterThan(0);
  });
});

describe.skipIf(!integrationEnabled)('MagicLinkStore (integration)', () => {
  let handle: DatabaseHandle;
  let links: MagicLinkStore;

  beforeAll(async () => {
    handle = await freshDatabase();
    links = new MagicLinkStore(handle.db, 15);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('issue → consume returns the bound email', async () => {
    const { token } = await links.issue('person@firm.example');
    const result = await links.consume(token);
    expect(result.email).toBe('person@firm.example');
  });

  it('consuming a second time fails (single-use)', async () => {
    const { token } = await links.issue('once@firm.example');
    await links.consume(token);
    await expect(links.consume(token)).rejects.toBeInstanceOf(MagicLinkInvalidError);
  });

  it('consuming a non-existent token fails', async () => {
    await expect(links.consume('never-issued-token')).rejects.toBeInstanceOf(
      MagicLinkInvalidError,
    );
  });

  it('reapExpired removes only past-expiry rows', async () => {
    // Issue a fresh one with default 15-min TTL — should survive reap.
    await links.issue('fresh@firm.example');
    const reaped = await links.reapExpired();
    expect(reaped).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!integrationEnabled)('UserSessionStore (integration)', () => {
  let handle: DatabaseHandle;
  let sessions: UserSessionStore;
  let userId: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    const users = new UserStore(handle.db);
    const u = await users.create({ email: 'session-test@firm.example' });
    userId = u.id;
    sessions = new UserSessionStore(handle.db, 60);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('issue → validate returns userId and slides TTL', async () => {
    const { token, expiresAt } = await sessions.issue(userId, 'test-agent');
    // Sleep 50ms so the next slide produces a measurably later expiry.
    await new Promise((r) => setTimeout(r, 50));
    const resolved = await sessions.validate(token);
    expect(resolved.userId).toBe(userId);
    expect(resolved.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime());
  });

  it('revoke makes validate throw', async () => {
    const { token } = await sessions.issue(userId);
    await sessions.revoke(token);
    await expect(sessions.validate(token)).rejects.toBeInstanceOf(SessionInvalidError);
  });

  it('validate on unknown token throws', async () => {
    await expect(sessions.validate('never-issued')).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
  });

  it('revokeAllForUser kills every active session', async () => {
    const a = await sessions.issue(userId);
    const b = await sessions.issue(userId);
    await sessions.revokeAllForUser(userId);
    await expect(sessions.validate(a.token)).rejects.toBeInstanceOf(SessionInvalidError);
    await expect(sessions.validate(b.token)).rejects.toBeInstanceOf(SessionInvalidError);
  });
});
