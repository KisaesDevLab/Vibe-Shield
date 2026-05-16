/**
 * /v1/admin/* integration tests.
 *
 * Primary purpose (v1.1.3 §review): regression-guard for Defect #4
 * from the round-1 verification sweep. Admin routes must reach the
 * X-Admin-Key middleware BEFORE the /v1/* tenant Bearer middleware.
 * Without the correct mount order, `/v1/admin/api-keys` 401s on
 * missing Authorization before ever reaching the X-Admin-Key check
 * and the admin UI is non-functional.
 *
 * Also covers:
 *   - X-Admin-Key timing-safe compare (wrong-key → 401)
 *   - Cleartext-key-shown-once contract on issue
 *   - Idempotent revoke
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DatabaseHandle } from '@kisaesdevlab/vibe-shield-schema';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

const ADMIN_KEY = 'vs-admin-test-1234567890';

describe.skipIf(!integrationEnabled)('/v1/admin/* routing', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    handle = await freshDatabase();
    app = buildTestApp({ handle, adminKey: ADMIN_KEY });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('admin route reachable with X-Admin-Key only (regression: Defect #4)', async () => {
    // Critical: the admin router must mount BEFORE the v1 tenant
    // router. Without that, `apiKeyMiddleware` fires first and
    // 401s on the missing Authorization header.
    const r = await request(app)
      .get('/v1/admin/api-keys')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('missing X-Admin-Key → 401', async () => {
    const r = await request(app).get('/v1/admin/api-keys');
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe('authentication_error');
  });

  it('wrong X-Admin-Key → 401 (timing-safe compare)', async () => {
    const r = await request(app)
      .get('/v1/admin/api-keys')
      .set('X-Admin-Key', 'vs-admin-wrong-value');
    expect(r.status).toBe(401);
  });

  it('POST /v1/admin/api-keys returns cleartext exactly once', async () => {
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ tenantId: 't-review', appId: 'review', label: 'review-key' });
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe('string');
    expect(typeof r.body.key).toBe('string');
    expect(r.body.key).toMatch(/^vs_live_/);

    // Subsequent list MUST NOT include the cleartext key.
    const list = await request(app)
      .get('/v1/admin/api-keys')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(list.status).toBe(200);
    const row = list.body.find((k: { id: string }) => k.id === r.body.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('key');
  });

  it('DELETE is idempotent — second delete returns 404', async () => {
    const created = await request(app)
      .post('/v1/admin/api-keys')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ tenantId: 't-rev', appId: 'review', label: 'rev' });
    const id = created.body.id as string;

    const first = await request(app)
      .delete(`/v1/admin/api-keys/${id}`)
      .set('X-Admin-Key', ADMIN_KEY);
    expect(first.status).toBe(204);

    const second = await request(app)
      .delete(`/v1/admin/api-keys/${id}`)
      .set('X-Admin-Key', ADMIN_KEY);
    // Second delete: row already revoked → revokeByHashHex returns false → 404
    expect(second.status).toBe(404);
  });
});
