/**
 * Correlation-ID middleware tests (v1.1.3 §review S5).
 *
 * The x-correlation-id header is user-supplied AND echoed in response
 * headers AND included in structured logs. Without sanitization, a CRLF
 * value would forge log lines and smuggle response headers.
 */

import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  CORRELATION_HEADER,
  correlationIdMiddleware,
} from '../src/middleware/correlation-id.js';

function buildApp(): express.Express {
  const app = express();
  app.use(correlationIdMiddleware);
  app.get('/x', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('correlationIdMiddleware', () => {
  it('echoes a safe incoming correlation ID', async () => {
    const app = buildApp();
    const r = await request(app)
      .get('/x')
      .set(CORRELATION_HEADER, 'req-12345-abcdef');
    expect(r.headers[CORRELATION_HEADER]).toBe('req-12345-abcdef');
  });

  it('generates a fresh UUID when no header is supplied', async () => {
    const app = buildApp();
    const r = await request(app).get('/x');
    expect(r.headers[CORRELATION_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects a header containing CRLF (regression: S5 CRLF log forgery)', () => {
    // Node's HTTP parser already rejects CRLF in header values
    // (ERR_INVALID_CHAR), so this attack can't reach the middleware
    // via a real HTTP request. The middleware's regex is
    // defense-in-depth for any future direct invocation (test code,
    // in-process forwarding, etc.). Test directly with a stub req/res.
    const cids: string[] = [];
    const req = {
      header: (name: string) =>
        name.toLowerCase() === CORRELATION_HEADER ? 'abc\r\nINFO injected' : undefined,
    } as unknown as Parameters<typeof correlationIdMiddleware>[0];
    const res = {
      setHeader: (_n: string, v: string) => {
        cids.push(v);
      },
    } as unknown as Parameters<typeof correlationIdMiddleware>[1];
    correlationIdMiddleware(req, res, () => undefined);
    expect(cids).toHaveLength(1);
    expect(cids[0]).not.toContain('injected');
    expect(cids[0]).not.toContain('\n');
    expect(cids[0]).toMatch(/^[0-9a-f]{8}/);
  });

  it('rejects a header with a bare newline (direct invocation)', () => {
    const cids: string[] = [];
    const req = {
      header: () => 'abc\nINFO leak',
    } as unknown as Parameters<typeof correlationIdMiddleware>[0];
    const res = {
      setHeader: (_n: string, v: string) => {
        cids.push(v);
      },
    } as unknown as Parameters<typeof correlationIdMiddleware>[1];
    correlationIdMiddleware(req, res, () => undefined);
    expect(cids[0]).not.toContain('\n');
    expect(cids[0]).toMatch(/^[0-9a-f]{8}/);
  });

  it('rejects a header longer than 128 chars', async () => {
    const app = buildApp();
    const long = 'a'.repeat(129);
    const r = await request(app).get('/x').set(CORRELATION_HEADER, long);
    expect(r.headers[CORRELATION_HEADER]).not.toBe(long);
    expect(r.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f]{8}/);
  });

  it('accepts a 128-char header exactly at the limit', async () => {
    const app = buildApp();
    const exact = 'a'.repeat(128);
    const r = await request(app).get('/x').set(CORRELATION_HEADER, exact);
    expect(r.headers[CORRELATION_HEADER]).toBe(exact);
  });

  it('rejects a header containing a quote (response-splitting hardening)', async () => {
    const app = buildApp();
    const r = await request(app).get('/x').set(CORRELATION_HEADER, 'abc"def');
    expect(r.headers[CORRELATION_HEADER]).not.toContain('"');
  });
});
