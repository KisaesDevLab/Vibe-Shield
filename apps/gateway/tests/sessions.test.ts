import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ApiKeyStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('/v1/sessions', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof buildTestApp>;
  let acmeKey: string;
  let bobKey: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    const store = new ApiKeyStore(handle.db);
    acmeKey = (await store.issue({ tenantId: 'acme', appId: 'mybooks', name: 'a' })).key;
    bobKey = (await store.issue({ tenantId: 'bob', appId: 'mybooks', name: 'b' })).key;
    app = buildTestApp({ handle });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('POST /v1/sessions creates a session bound to the auth tenant', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${acmeKey}`)
      .send({ user_id: 'alice' });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.tenant_id).toBe('acme');
    expect(r.body.app_id).toBe('mybooks');
    expect(r.body.user_id).toBe('alice');
    expect(new Date(r.body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('POST /v1/sessions honors custom ttl_minutes', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${acmeKey}`)
      .send({ user_id: 'alice', ttl_minutes: 5 });
    expect(r.status).toBe(201);
    const ttlMs = new Date(r.body.expires_at).getTime() - new Date(r.body.created_at).getTime();
    expect(ttlMs).toBeGreaterThan(4 * 60_000);
    expect(ttlMs).toBeLessThan(6 * 60_000);
  });

  it('POST /v1/sessions rejects malformed body', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${acmeKey}`)
      .send({ user_id: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe('invalid_request_error');
  });

  it('GET /v1/sessions/:id fetches by id when owned by tenant', async () => {
    const created = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${acmeKey}`)
      .send({ user_id: 'alice' });
    const got = await request(app)
      .get(`/v1/sessions/${created.body.id}`)
      .set('Authorization', `Bearer ${acmeKey}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(created.body.id);
  });

  it('GET /v1/sessions/:id returns 404 for sessions owned by another tenant', async () => {
    const acme = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${acmeKey}`)
      .send({ user_id: 'alice' });
    const r = await request(app)
      .get(`/v1/sessions/${acme.body.id}`)
      .set('Authorization', `Bearer ${bobKey}`);
    // 404, not 403 — never confirm the existence of another tenant's row.
    expect(r.status).toBe(404);
  });

  it('GET /v1/sessions/:id rejects non-UUID', async () => {
    const r = await request(app)
      .get('/v1/sessions/not-a-uuid')
      .set('Authorization', `Bearer ${acmeKey}`);
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe('invalid_request_error');
  });

  it('DELETE /v1/sessions/:id purges only own sessions', async () => {
    const acme = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${acmeKey}`)
      .send({ user_id: 'alice' });
    // Bob can't delete acme's session.
    const bobAttempt = await request(app)
      .delete(`/v1/sessions/${acme.body.id}`)
      .set('Authorization', `Bearer ${bobKey}`);
    expect(bobAttempt.status).toBe(404);
    // Acme can.
    const acmeDelete = await request(app)
      .delete(`/v1/sessions/${acme.body.id}`)
      .set('Authorization', `Bearer ${acmeKey}`);
    expect(acmeDelete.status).toBe(204);
    // Subsequent fetch confirms gone.
    const afterDelete = await request(app)
      .get(`/v1/sessions/${acme.body.id}`)
      .set('Authorization', `Bearer ${acmeKey}`);
    expect(afterDelete.status).toBe(404);
  });
});
