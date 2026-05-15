/**
 * Materialize endpoint tests (addendum 16.5).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ApiKeyStore,
  type DatabaseHandle,
  SessionManager,
  TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import { PolicyResolver } from '../src/policy/resolver.js';
import {
  buildTestApp,
  freshDatabase,
  integrationEnabled,
  StaticKeyResolver,
} from './setup.js';

describe.skipIf(!integrationEnabled)('POST /v1/sessions/:id/materialize', () => {
  let handle: DatabaseHandle;
  let converterKey: string;
  let mybooksKey: string;
  let app: ReturnType<typeof buildTestApp>;
  let sessions: SessionManager;
  let vault: TokenVault;
  let policies: PolicyResolver;

  beforeAll(async () => {
    handle = await freshDatabase();
    const apiKeys = new ApiKeyStore(handle.db);
    converterKey = (await apiKeys.issue({ tenantId: 'acme', appId: 'converter', name: 'conv' })).key;
    mybooksKey = (await apiKeys.issue({ tenantId: 'acme', appId: 'mybooks', name: 'mb' })).key;
    sessions = new SessionManager(handle.db);
    vault = new TokenVault(handle.db, new StaticKeyResolver());
    policies = new PolicyResolver(handle.db);
    await policies.ensureLoaded();
    app = buildTestApp({ handle, sessions, vault, apiKeys, policies });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('resolves tokens when called under cpa-converter-output policy', async () => {
    // Set up a session and pre-populate it with allocations.
    const session = await sessions.create({
      tenantId: 'acme',
      appId: 'converter',
      userId: 'alice',
    });
    const a1 = await vault.allocate(session.id, 'PERSON', 'Jane Doe');
    const a2 = await vault.allocate(session.id, 'US_BANK_ACCOUNT', '123456789012');

    const r = await request(app)
      .post(`/v1/sessions/${session.id}/materialize`)
      .set('Authorization', `Bearer ${converterKey}`)
      .send({
        payload: {
          holder: a1.token,
          account: a2.token,
          memos: [`Statement for ${a1.token}`],
        },
        output_filename: 'acme-chase-2026-04.ofx',
      });
    expect(r.status).toBe(200);
    expect(r.body.materialized.holder).toBe('Jane Doe');
    expect(r.body.materialized.account).toBe('123456789012');
    expect(r.body.materialized.memos[0]).toContain('Jane Doe');
    expect(r.body.tokens_resolved).toBe(2);
    expect(r.body.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses materialize when called under a non-converter policy', async () => {
    const session = await sessions.create({
      tenantId: 'acme',
      appId: 'mybooks',
      userId: 'alice',
    });
    const r = await request(app)
      .post(`/v1/sessions/${session.id}/materialize`)
      .set('Authorization', `Bearer ${mybooksKey}`)
      .send({ payload: { x: 'y' } });
    expect(r.status).toBe(403);
    expect(r.body.error.type).toBe('permission_error');
    expect(r.body.error.message).toContain('cpa-converter-output');
  });

  it('returns 404 for sessions belonging to another tenant', async () => {
    const session = await sessions.create({
      tenantId: 'acme',
      appId: 'converter',
      userId: 'alice',
    });
    // Different-tenant key — issued under "evil" tenant.
    const apiKeys = new ApiKeyStore(handle.db);
    const evilKey = (
      await apiKeys.issue({ tenantId: 'evil', appId: 'converter', name: 'evil' })
    ).key;
    const r = await request(app)
      .post(`/v1/sessions/${session.id}/materialize`)
      .set('Authorization', `Bearer ${evilKey}`)
      .send({ payload: { x: 'y' } });
    expect(r.status).toBe(404);
  });

  it('returns 400 for non-UUID session id', async () => {
    const r = await request(app)
      .post('/v1/sessions/not-a-uuid/materialize')
      .set('Authorization', `Bearer ${converterKey}`)
      .send({ payload: { x: 'y' } });
    expect(r.status).toBe(400);
  });

  it('emits a materialize audit event with the output hash', async () => {
    // Hard to inspect the audit table directly without exposing it, but
    // we can fetch the count via the schema package's AuditLogger after
    // the call. Skipping deep-DB inspection here; covered in
    // packages/schema audit-logger.test.ts.
    const session = await sessions.create({
      tenantId: 'acme',
      appId: 'converter',
      userId: 'alice',
    });
    const r = await request(app)
      .post(`/v1/sessions/${session.id}/materialize`)
      .set('Authorization', `Bearer ${converterKey}`)
      .send({ payload: { foo: 'bar' } });
    expect(r.status).toBe(200);
    expect(r.body.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes through unknown tokens unchanged (no hallucinated re-id)', async () => {
    const session = await sessions.create({
      tenantId: 'acme',
      appId: 'converter',
      userId: 'alice',
    });
    const r = await request(app)
      .post(`/v1/sessions/${session.id}/materialize`)
      .set('Authorization', `Bearer ${converterKey}`)
      .send({ payload: { x: '<HALLUCINATED_99>' } });
    expect(r.status).toBe(200);
    expect(r.body.materialized.x).toBe('<HALLUCINATED_99>');
    expect(r.body.tokens_resolved).toBe(0);
  });
});
