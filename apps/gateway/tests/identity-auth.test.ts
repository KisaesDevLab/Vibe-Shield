/**
 * End-to-end /api/auth/* + RBAC tests — Phase 24.
 *
 * Skips when DATABASE_URL is unset. Magic-link emails are stubbed
 * (we use the schema MagicLinkStore directly to issue tokens, then
 * call /api/auth/consume?token=...). The SMTP path is exercised via
 * a stub Mailer so we don't depend on a real relay.
 *
 * Tests:
 *   - issue + consume sets the vs_session cookie
 *   - /api/auth/me returns the user
 *   - /v1/admin/* accepts org_admin session cookie WITHOUT X-Admin-Key
 *   - X-Admin-Key path still works (backward-compat)
 *   - expired magic link rejected
 *   - logout revokes the session
 *   - non-org-admin user is blocked from admin routes
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import {
  ApiKeyStore,
  AuditLogger,
  MagicLinkStore,
  SessionManager,
  TokenVault,
  UserSessionStore,
  UserStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import { createApp } from '../src/app.js';
import { freshDatabase, integrationEnabled, StaticKeyResolver, stubAnthropic, stubEngine, emptyMessage } from './setup.js';
import { SESSION_COOKIE_NAME } from '../src/auth/cookie.js';
import type { Mailer } from '../src/auth/mailer.js';

const ADMIN_KEY = 'vs-admin-identity-test-1234567890';

class StubMailer implements Pick<Mailer, 'sendMagicLink' | 'verify'> {
  public sent: Array<{ to: string; url: string }> = [];
  async sendMagicLink(opts: { to: string; url: string }): Promise<void> {
    this.sent.push({ to: opts.to, url: opts.url });
  }
  async verify(): Promise<void> {
    return;
  }
}

const silent = pino({ level: 'silent' });

function buildIdentityApp(handle: DatabaseHandle, mailer?: StubMailer) {
  const users = new UserStore(handle.db);
  const userSessions = new UserSessionStore(handle.db, 60);
  const magicLinks = new MagicLinkStore(handle.db, 15);
  const audit = new AuditLogger(handle.db);
  return {
    app: createApp({
      db: handle.db,
      apiKeys: new ApiKeyStore(handle.db),
      sessions: new SessionManager(handle.db),
      vault: new TokenVault(handle.db, new StaticKeyResolver()),
      engine: stubEngine(),
      anthropic: stubAnthropic(emptyMessage()),
      logger: silent,
      maxRequestBytes: 64 * 1024,
      sessionTtlMinutes: 60,
      adminKey: ADMIN_KEY,
      users,
      userSessions,
      magicLinks,
      audit,
      ...(mailer !== undefined ? { mailer: mailer as unknown as Mailer } : {}),
      publicUrl: 'http://localhost.test',
    }),
    users,
    userSessions,
    magicLinks,
    audit,
  };
}

function extractSessionCookie(setCookie: string | undefined): string | null {
  if (setCookie === undefined) return null;
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  return m === null ? null : decodeURIComponent(m[1]!);
}

describe.skipIf(!integrationEnabled)('/api/auth + RBAC (Phase 24)', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await freshDatabase();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('legacy X-Admin-Key path still reaches /v1/admin/* after RBAC lands', async () => {
    const { app } = buildIdentityApp(handle);
    const r = await request(app)
      .get('/v1/admin/api-keys')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(r.status).toBe(200);
  });

  it('request-link returns 501 when SMTP is unset', async () => {
    const { app } = buildIdentityApp(handle);
    const r = await request(app)
      .post('/api/auth/request-link')
      .send({ email: 'nobody@firm.example' });
    expect(r.status).toBe(501);
  });

  it('request-link is 204 whether the email exists or not (anti-enumeration)', async () => {
    const mailer = new StubMailer();
    const { app, users } = buildIdentityApp(handle, mailer);
    await users.create({ email: 'real@firm.example', isOrgAdmin: true });

    const r1 = await request(app)
      .post('/api/auth/request-link')
      .send({ email: 'real@firm.example' });
    const r2 = await request(app)
      .post('/api/auth/request-link')
      .send({ email: 'fake@firm.example' });
    expect(r1.status).toBe(204);
    expect(r2.status).toBe(204);
    // Only the real email got an email.
    expect(mailer.sent.find((s) => s.to === 'real@firm.example')).toBeDefined();
    expect(mailer.sent.find((s) => s.to === 'fake@firm.example')).toBeUndefined();
  });

  it('end-to-end: issue link → consume sets cookie → /api/auth/me works', async () => {
    const mailer = new StubMailer();
    const { app, users, magicLinks } = buildIdentityApp(handle, mailer);
    const user = await users.create({
      email: 'e2e@firm.example',
      isOrgAdmin: true,
    });
    await users.setRole(user.id, 'redact', 'admin');
    const { token } = await magicLinks.issue('e2e@firm.example');

    const consumeRes = await request(app)
      .get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
    expect([302]).toContain(consumeRes.status);
    const cookieHeader = consumeRes.headers['set-cookie'];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const sessionCookie = extractSessionCookie(setCookie);
    expect(sessionCookie).not.toBeNull();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionCookie!}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('e2e@firm.example');
    expect(me.body.is_org_admin).toBe(true);
    expect(me.body.roles.redact).toBe('admin');
  });

  it('org_admin session reaches /v1/admin/* without X-Admin-Key', async () => {
    const mailer = new StubMailer();
    const { app, users, magicLinks } = buildIdentityApp(handle, mailer);
    await users.create({ email: 'org@firm.example', isOrgAdmin: true });
    const { token } = await magicLinks.issue('org@firm.example');
    const consume = await request(app)
      .get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
    const cookieHeader = consume.headers['set-cookie'];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const session = extractSessionCookie(setCookie)!;

    const r = await request(app)
      .get('/v1/admin/api-keys')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session}`);
    expect(r.status).toBe(200);
  });

  it('non-org-admin session is blocked from /v1/admin/*', async () => {
    const mailer = new StubMailer();
    const { app, users, magicLinks } = buildIdentityApp(handle, mailer);
    await users.create({ email: 'limited@firm.example', isOrgAdmin: false });
    const { token } = await magicLinks.issue('limited@firm.example');
    const consume = await request(app)
      .get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
    const cookieHeader = consume.headers['set-cookie'];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const session = extractSessionCookie(setCookie)!;

    const r = await request(app)
      .get('/v1/admin/api-keys')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session}`);
    // Limited user has no admin key AND no org_admin — adminAuthMiddleware
    // rejects with 401 because both auth paths fail.
    expect(r.status).toBe(401);
  });

  it('expired magic link is rejected', async () => {
    const mailer = new StubMailer();
    const { app, users } = buildIdentityApp(handle, mailer);
    await users.create({ email: 'expiry@firm.example', isOrgAdmin: true });
    // Issue with a 15-minute TTL store, but manually expire it by
    // re-issuing through a zero-TTL store sharing the same DB.
    const shortLived = new MagicLinkStore(handle.db, 0);
    const { token } = await shortLived.issue('expiry@firm.example');
    // Wait a beat so expires_at is past.
    await new Promise((r) => setTimeout(r, 50));
    const r = await request(app)
      .get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
    expect(r.status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const mailer = new StubMailer();
    const { app, users, magicLinks } = buildIdentityApp(handle, mailer);
    await users.create({ email: 'logout@firm.example', isOrgAdmin: true });
    const { token } = await magicLinks.issue('logout@firm.example');
    const consume = await request(app)
      .get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
    const cookieHeader = consume.headers['set-cookie'];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const session = extractSessionCookie(setCookie)!;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session}`);
    expect(logoutRes.status).toBe(204);

    const after = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session}`);
    expect(after.status).toBe(401);
  });

  it('POST /v1/admin/users creates a user with roles and triggers an invite email', async () => {
    const mailer = new StubMailer();
    const { app, users, magicLinks } = buildIdentityApp(handle, mailer);
    await users.create({ email: 'orgadmin-invite@firm.example', isOrgAdmin: true });
    const { token } = await magicLinks.issue('orgadmin-invite@firm.example');
    const consume = await request(app)
      .get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
    const cookieHeader = consume.headers['set-cookie'];
    const setCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    const session = extractSessionCookie(setCookie)!;

    const r = await request(app)
      .post('/v1/admin/users')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${session}`)
      .send({
        email: 'invitee@firm.example',
        roles: { redact: 'operator' },
      });
    expect(r.status).toBe(201);
    expect(r.body.invited).toBe(true);
    expect(mailer.sent.find((s) => s.to === 'invitee@firm.example')).toBeDefined();

    // And the user is hydrated with the role.
    const created = await users.findByEmail('invitee@firm.example');
    expect(created).not.toBeNull();
    const hydrated = await users.findByIdWithRoles(created!.id);
    expect(hydrated?.roles.redact).toBe('operator');
  });
});

// Avoid unused-import warning on express in case the test file is
// loaded without integration env.
void express;
