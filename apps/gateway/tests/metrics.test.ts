import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { type DatabaseHandle } from '@kisaesdevlab/vibe-shield-schema';
import { buildTestApp, freshDatabase, integrationEnabled } from './setup.js';

describe.skipIf(!integrationEnabled)('GET /metrics', () => {
  let handle: DatabaseHandle;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    handle = await freshDatabase();
    app = buildTestApp({ handle });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('returns Prometheus exposition format', async () => {
    // Drive at least one request first so HTTP metrics have a sample.
    await request(app).get('/health');
    const r = await request(app).get('/metrics');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.text).toContain('vs_gateway_http_requests_total');
    expect(r.text).toContain('vs_gateway_http_latency_seconds');
  });

  it('exposes default Node.js metrics with the vs_gateway_ prefix', async () => {
    const r = await request(app).get('/metrics');
    expect(r.text).toContain('vs_gateway_process_cpu_user_seconds_total');
  });

  it('exposes the Vibe-specific counters even at zero', async () => {
    const r = await request(app).get('/metrics');
    expect(r.text).toContain('vs_gateway_proxy_calls_total');
    expect(r.text).toContain('vs_gateway_anthropic_input_tokens_total');
    expect(r.text).toContain('vs_gateway_spend_microdollars_total');
    expect(r.text).toContain('vs_gateway_recognizer_misses_total');
    expect(r.text).toContain('vs_gateway_rate_limit_breaches_total');
    expect(r.text).toContain('vs_gateway_spend_cap_breaches_total');
    expect(r.text).toContain('vs_gateway_materialize_events_total');
  });
});
