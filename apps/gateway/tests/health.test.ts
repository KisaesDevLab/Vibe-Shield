import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DatabaseHandle } from '@kisaesdevlab/vibe-shield-schema';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('health + ready', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    handle = await freshDatabase();
    app = buildTestApp({ handle });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('GET /health returns 200', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });

  it('GET /ready confirms DB connectivity', async () => {
    const r = await request(app).get('/ready');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ready');
    expect(r.body.database).toBe('ok');
  });

  it('GET /openapi.json returns a valid spec shape', async () => {
    const r = await request(app).get('/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(r.body.info.title).toContain('Vibe Shield');
    expect(r.body.paths['/v1/messages']).toBeDefined();
    expect(r.body.paths['/v1/sessions']).toBeDefined();
  });

  it('correlation ID echoes when client provides one', async () => {
    const r = await request(app)
      .get('/health')
      .set('X-Correlation-Id', 'test-cid-1234');
    expect(r.headers['x-correlation-id']).toBe('test-cid-1234');
  });

  it('correlation ID is auto-generated when client omits one', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
