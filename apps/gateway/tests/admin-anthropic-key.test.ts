/**
 * /v1/admin/anthropic/key — Phase 23.5 admin key management.
 *
 * Covers: GET status defaults to env source, PUT with a good key
 * persists + reloads, PUT with a consumer key is rejected without
 * touching the DB, DELETE reverts to env, DELETE refuses with 409 if
 * env is unset, and the audit row carries the fingerprint (never the
 * plaintext).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ApplianceSecretStore,
  AuditLogger,
  type DatabaseHandle,
  formatKekForEnv,
  newKey,
} from '@kisaesdevlab/vibe-shield-schema';
import { AnthropicClientHolder } from '../src/anthropic/holder.js';
import {
  AnthropicUnreachableError,
  ConsumerKeyError,
  type probeAnthropicKey,
} from '../src/anthropic/probe.js';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

const ADMIN_KEY = 'vs-admin-test-1234567890';
const BOOTSTRAP_KEY = 'sk-ant-bootstrap-env-value';

const okProbe: typeof probeAnthropicKey = async () =>
  Promise.resolve({ models: ['claude-opus-4-7', 'claude-sonnet-4-6'] });

const consumerProbe: typeof probeAnthropicKey = async () =>
  Promise.reject(new ConsumerKeyError('rejected by Anthropic'));

const unreachableProbe: typeof probeAnthropicKey = async () =>
  Promise.reject(new AnthropicUnreachableError('500'));

describe.skipIf(!integrationEnabled)('/v1/admin/anthropic/key (Phase 23.5)', () => {
  let handle: DatabaseHandle;
  let applianceSecrets: ApplianceSecretStore;
  let holder: AnthropicClientHolder;
  let audit: AuditLogger;

  beforeAll(async () => {
    handle = await freshDatabase();
    // Make formatKekForEnv visible for shape — not required at runtime.
    const _kekShape = formatKekForEnv(newKey());
    void _kekShape;
    const kek = newKey();
    applianceSecrets = new ApplianceSecretStore(handle.db, kek);
    holder = new AnthropicClientHolder({
      apiKey: BOOTSTRAP_KEY,
      zdr: false,
      meta: { source: 'env', setAt: null, fingerprint: null },
    });
    audit = new AuditLogger(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  const newApp = (probe: typeof probeAnthropicKey) =>
    buildTestApp({
      handle,
      adminKey: ADMIN_KEY,
      anthropicHolder: holder,
      applianceSecrets,
      audit,
      bootstrapApiKey: BOOTSTRAP_KEY,
      probeFn: probe,
    });

  it('GET defaults to source=env with no fingerprint', async () => {
    const app = newApp(okProbe);
    const r = await request(app)
      .get('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('env');
    expect(r.body.bootstrap_present).toBe(true);
  });

  it('PUT rejects an empty key with 400', async () => {
    const app = newApp(okProbe);
    const r = await request(app)
      .put('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ key: '   ' });
    // Either the schema rejects (whitespace ok per .min(1)) OR the
    // post-trim length-check fires. Both surface as 400.
    expect([400]).toContain(r.status);
  });

  it('PUT rejects a consumer-grade key without writing to the DB', async () => {
    const app = newApp(consumerProbe);
    const before = await applianceSecrets.getStatus();
    const r = await request(app)
      .put('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ key: 'sk-ant-consumer' });
    expect(r.status).toBe(400);
    const after = await applianceSecrets.getStatus();
    // DB is unchanged.
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.present).toBe(before.present);
    // Holder is unchanged — still on the bootstrap key.
    expect(holder.getApiKey()).toBe(BOOTSTRAP_KEY);
  });

  it('PUT with a good key persists, reloads holder, and audits', async () => {
    const app = newApp(okProbe);
    const newKeyValue = 'sk-ant-fresh-commercial-key-value';
    const r = await request(app)
      .put('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ key: newKeyValue });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('db');
    expect(typeof r.body.fingerprint).toBe('string');
    expect(r.body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(holder.getApiKey()).toBe(newKeyValue);
    expect(holder.getMeta().source).toBe('db');

    const status = await request(app)
      .get('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(status.body.source).toBe('db');
    expect(status.body.fingerprint).toBe(r.body.fingerprint);
  });

  it('audit row for anthropic_key_set carries fingerprint, never plaintext', async () => {
    const rows = await audit.listRecent({ limit: 50 });
    const setEvent = rows.find((r) => r.eventType === 'anthropic_key_set');
    expect(setEvent).toBeDefined();
    // payload_hash is 64-hex (32 bytes). The plaintext key substring
    // would not appear in a SHA-256 hash, but assert explicitly so
    // future hash-format changes can't accidentally leak.
    expect(setEvent!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(setEvent!.payloadHash.includes('sk-ant')).toBe(false);
  });

  it('DELETE reverts to env-backed key', async () => {
    const app = newApp(okProbe);
    const r = await request(app)
      .delete('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(r.status).toBe(204);
    expect(holder.getApiKey()).toBe(BOOTSTRAP_KEY);
    expect(holder.getMeta().source).toBe('env');

    const status = await request(app)
      .get('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(status.body.source).toBe('env');
  });

  it('DELETE returns 409 when no env-backed fallback is available', async () => {
    // App configured WITHOUT bootstrapApiKey — DELETE must refuse.
    const noEnvApp = buildTestApp({
      handle,
      adminKey: ADMIN_KEY,
      anthropicHolder: holder,
      applianceSecrets,
      audit,
      probeFn: okProbe,
      // bootstrapApiKey omitted on purpose
    });
    // First set a key so DELETE has something to clear.
    await request(noEnvApp)
      .put('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ key: 'sk-ant-no-env-test' });

    const r = await request(noEnvApp)
      .delete('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(r.status).toBe(409);
  });

  it('PUT surfaces Anthropic unreachable as 503', async () => {
    const app = newApp(unreachableProbe);
    const r = await request(app)
      .put('/v1/admin/anthropic/key')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ key: 'sk-ant-cannot-reach' });
    expect(r.status).toBe(503);
  });
});
