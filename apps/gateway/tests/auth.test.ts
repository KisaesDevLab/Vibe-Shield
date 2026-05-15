import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ApiKeyStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('api-key auth', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof buildTestApp>;
  let validKey: string;
  let revokedKey: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    const store = new ApiKeyStore(handle.db);
    const issued = await store.issue({
      tenantId: 'acme',
      appId: 'mybooks',
      name: 'integration-test',
    });
    validKey = issued.key;
    const revoked = await store.issue({
      tenantId: 'acme',
      appId: 'mybooks',
      name: 'revoked',
    });
    revokedKey = revoked.key;
    await store.revoke(revoked.record.keyHash);
    app = buildTestApp({ handle });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('rejects missing Authorization with 401 + Anthropic envelope', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .send({ user_id: 'alice' });
    expect(r.status).toBe(401);
    expect(r.body.type).toBe('error');
    expect(r.body.error.type).toBe('authentication_error');
  });

  it('rejects non-Bearer Authorization', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', 'Basic ' + Buffer.from('a:b').toString('base64'))
      .send({ user_id: 'alice' });
    expect(r.status).toBe(401);
  });

  it('rejects unknown vs_live_ key', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', 'Bearer vs_live_' + 'A'.repeat(24))
      .send({ user_id: 'alice' });
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe('authentication_error');
  });

  it('rejects badly-formatted key', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', 'Bearer notakey')
      .send({ user_id: 'alice' });
    expect(r.status).toBe(401);
  });

  it('rejects revoked key with 403', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${revokedKey}`)
      .send({ user_id: 'alice' });
    expect(r.status).toBe(403);
    expect(r.body.error.type).toBe('permission_error');
  });

  it('accepts a valid key and creates a session', async () => {
    const r = await request(app)
      .post('/v1/sessions')
      .set('Authorization', `Bearer ${validKey}`)
      .send({ user_id: 'alice' });
    expect(r.status).toBe(201);
    expect(r.body.tenant_id).toBe('acme');
    expect(r.body.app_id).toBe('mybooks');
  });
});
