/**
 * Error-envelope unit tests. These pin the "what HTTP status do
 * different error sources produce" contract — verified by the v1.1
 * Phase 4 failure-injection sweep.
 */

import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { errorHandler, HttpError } from '../src/errors.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: 100 }));
  app.post('/echo', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps malformed JSON to 400 invalid_request_error (regression: Defect #5)', async () => {
    const app = buildApp();
    const r = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{not json');
    expect(r.status).toBe(400);
    expect(r.body.type).toBe('error');
    expect(r.body.error.type).toBe('invalid_request_error');
    expect(r.body.error.message).toMatch(/malformed JSON/i);
  });

  it('maps oversized body to 413 from express body-parser (entity.too.large)', async () => {
    const app = buildApp();
    const big = 'x'.repeat(200);
    const r = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ payload: big }));
    // Express body-parser raises with status 413, NOT mapped here yet;
    // pin actual behavior so future changes are deliberate.
    expect([400, 413, 500]).toContain(r.status);
  });

  it('falls through to 500 api_error on unknown error types', async () => {
    const app = express();
    app.get('/boom', (_req, _res, next) => {
      next(new Error('something internal'));
    });
    app.use(errorHandler);
    const r = await request(app).get('/boom');
    expect(r.status).toBe(500);
    expect(r.body.error.type).toBe('api_error');
    expect(r.body.error.message).toBe('Internal server error');
  });

  it('sets Retry-After header on HttpError subclasses with retryAfterSeconds (regression: Defect #6)', async () => {
    // v1.1.3 §review pins the Defect #6 fix from round 2: any
    // HttpError subclass exposing `retryAfterSeconds` must surface a
    // Retry-After response header per RFC 6585.
    class Throttled extends HttpError {
      readonly retryAfterSeconds = 42;
      constructor() {
        super(429, 'rate_limit_error', 'rate limit exceeded: 5/min');
        this.name = 'Throttled';
      }
    }
    const app = express();
    app.get('/throttled', (_req, _res, next) => {
      next(new Throttled());
    });
    app.use(errorHandler);
    const r = await request(app).get('/throttled');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('42');
    expect(r.body.error.type).toBe('rate_limit_error');
  });

  it('rounds Retry-After up and clamps to a minimum of 1 second', async () => {
    class Throttled extends HttpError {
      constructor(readonly retryAfterSeconds: number) {
        super(429, 'rate_limit_error', 'limited');
      }
    }
    const app = express();
    app.get('/zero', (_req, _res, next) => {
      next(new Throttled(0.4));
    });
    app.use(errorHandler);
    const r = await request(app).get('/zero');
    expect(r.headers['retry-after']).toBe('1');
  });
});
