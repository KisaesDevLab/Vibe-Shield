import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ApiKeyStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('POST /v1/messages (Phase 7 stub)', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof buildTestApp>;
  let key: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    const issued = await new ApiKeyStore(handle.db).issue({
      tenantId: 'acme',
      appId: 'mybooks',
      name: 'msg-test',
    });
    key = issued.key;
    app = buildTestApp({ handle });
  });

  afterAll(async () => {
    await handle.close();
  });

  const valid = {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hi' }],
  };

  it('returns 501 with Anthropic envelope for valid request', async () => {
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send(valid);
    expect(r.status).toBe(501);
    expect(r.body.type).toBe('error');
    expect(r.body.error.type).toBe('api_error');
    expect(r.body.error.message).toContain('Phase 8');
  });

  it('returns 400 with invalid_request_error for missing model', async () => {
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({ max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe('invalid_request_error');
    // Critical: the response must include the field name but not the
    // (potentially PII-carrying) input value.
    expect(r.body.error.message).toContain('model');
    expect(JSON.stringify(r.body)).not.toContain('234-56-7890');
  });

  it('returns 400 for wrong role', async () => {
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'wrong', content: 'Hi' }],
      });
    expect(r.status).toBe(400);
  });

  it('does not leak request body in 400 validation responses', async () => {
    const body = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 'invalid',
      messages: [{ role: 'user', content: 'SSN 234-56-7890 belongs to Jane Doe' }],
    };
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send(body);
    expect(r.status).toBe(400);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('234-56-7890');
    expect(text).not.toContain('Jane Doe');
  });

  it('requires authentication', async () => {
    const r = await request(app).post('/v1/messages').send(valid);
    expect(r.status).toBe(401);
  });
});
