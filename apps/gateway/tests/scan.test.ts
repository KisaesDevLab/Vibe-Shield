/**
 * Scan module — Phase 26 (v1.8 foundation) end-to-end tests.
 *
 * Stubbed engine — we don't run the Python container locally. The
 * stub fires the engine's NDJSON events through ``onEvent`` then
 * resolves with the summary so the pipeline persists rows
 * deterministically.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import {
  ApiKeyStore,
  AuditLogger,
  MagicLinkStore,
  ScanJobStore,
  SessionManager,
  TokenVault,
  UserSessionStore,
  UserStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import { createApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/auth/cookie.js';
import type {
  EngineClient,
  ScanEvent,
  ScanSummary,
} from '../src/engine/client.js';
import { ScanJobEvents } from '../src/scan/job-events.js';
import { ScanPipeline } from '../src/scan/pipeline.js';
import {
  emptyMessage,
  freshDatabase,
  integrationEnabled,
  StaticKeyResolver,
  stubAnthropic,
  stubEngine,
} from './setup.js';

const silent = pino({ level: 'silent' });

interface CannedScan {
  events: ScanEvent[];
  summary: ScanSummary;
}

function makeScanEngineStub(canned: CannedScan): EngineClient {
  return {
    redact: () => Promise.reject(new Error('not used')),
    analyze: () => Promise.reject(new Error('not used')),
    health: () => Promise.resolve({ status: 'ok', model_loaded: true }),
    redactImage: () => Promise.reject(new Error('not used')),
    redactPdf: () => Promise.reject(new Error('not used')),
    scan: async (
      _bytes: Buffer,
      _filename: string,
      _mime: string,
      opts: { onEvent?: (e: ScanEvent) => void } = {},
    ) => {
      if (opts.onEvent !== undefined) {
        for (const ev of canned.events) {
          opts.onEvent(ev);
        }
        opts.onEvent(canned.summary);
      }
      return canned.summary;
    },
  } as unknown as EngineClient;
}

const CANNED: CannedScan = {
  events: [
    {
      type: 'file_scanned',
      path: 'note.txt',
      mime: 'text/plain',
      size_bytes: 42,
      sha256: 'a'.repeat(64),
    },
    {
      type: 'finding',
      path: 'note.txt',
      entity_type: 'US_SSN',
      severity: 'high',
      location: 'line=1,char=10-21',
      snippet_redacted: 'Customer SSN <US_SSN>',
      sample_hash: 'b'.repeat(64),
    },
  ],
  summary: {
    type: 'summary',
    source_kind: 'file',
    files_count: 1,
    findings_count: 1,
    findings_high: 1,
    findings_medium: 0,
    findings_low: 0,
  },
};

async function consumeMagicLink(
  app: ReturnType<typeof createApp>,
  magicLinks: MagicLinkStore,
  email: string,
): Promise<string> {
  const { token } = await magicLinks.issue(email);
  const res = await request(app).get(`/api/auth/consume?token=${encodeURIComponent(token)}`);
  const setCookie = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0]
    : res.headers['set-cookie'];
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie ?? '');
  if (m === null) throw new Error('no session cookie returned');
  return `${SESSION_COOKIE_NAME}=${decodeURIComponent(m[1]!)}`;
}

async function pollUntilTerminal(
  app: ReturnType<typeof createApp>,
  cookie: string,
  jobId: string,
): Promise<{ status: string; findings_count: number }> {
  for (let i = 0; i < 50; i++) {
    const r = await request(app).get(`/v1/scan/jobs/${jobId}`).set('Cookie', cookie);
    const body = r.body as { status: string; findings_count: number };
    if (body.status === 'completed' || body.status === 'failed') return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job did not reach terminal state');
}

describe.skipIf(!integrationEnabled)('Scan module (Phase 26 v1.8)', () => {
  let handle: DatabaseHandle;
  let users: UserStore;
  let magicLinks: MagicLinkStore;
  let jobs: ScanJobStore;
  let pipeline: ScanPipeline;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await freshDatabase();
    users = new UserStore(handle.db);
    magicLinks = new MagicLinkStore(handle.db, 15);
    jobs = new ScanJobStore(handle.db);
    const engine = makeScanEngineStub(CANNED);
    pipeline = new ScanPipeline({
      jobs,
      engine,
      audit: new AuditLogger(handle.db),
      events: new ScanJobEvents(),
      logger: silent,
    });
    app = createApp({
      db: handle.db,
      apiKeys: new ApiKeyStore(handle.db),
      sessions: new SessionManager(handle.db),
      vault: new TokenVault(handle.db, new StaticKeyResolver()),
      engine: stubEngine(),
      anthropic: stubAnthropic(emptyMessage()),
      logger: silent,
      maxRequestBytes: 32 * 1024 * 1024,
      sessionTtlMinutes: 60,
      adminKey: 'vs-admin-scan-test',
      users,
      userSessions: new UserSessionStore(handle.db, 60),
      magicLinks,
      audit: new AuditLogger(handle.db),
      scanJobs: jobs,
      scanPipeline: pipeline,
      scanMaxUploadBytes: 25 * 1024 * 1024,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('rejects upload without a session', async () => {
    const r = await request(app)
      .post('/v1/scan/jobs')
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(r.status).toBe(401);
  });

  it('rejects upload when the user has no scan role', async () => {
    await users.create({ email: 'noscan@firm.example' });
    const cookie = await consumeMagicLink(app, magicLinks, 'noscan@firm.example');
    const r = await request(app)
      .post('/v1/scan/jobs')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(r.status).toBe(403);
  });

  it('upload → drain → findings list end-to-end', async () => {
    const op = await users.create({ email: 'scan-op@firm.example' });
    await users.setRole(op.id, 'scan', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'scan-op@firm.example');

    const upload = await request(app)
      .post('/v1/scan/jobs')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('SSN 123-45-6789'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
    expect(upload.status).toBe(202);
    const jobId = upload.body.id as string;

    const finalState = await pollUntilTerminal(app, cookie, jobId);
    expect(finalState.status).toBe('completed');
    expect(finalState.findings_count).toBe(1);

    // Findings list returns the canned high-severity SSN.
    const findings = await request(app)
      .get(`/v1/scan/jobs/${jobId}/findings`)
      .set('Cookie', cookie);
    expect(findings.status).toBe(200);
    expect(findings.body).toHaveLength(1);
    const f = findings.body[0] as { entity_type: string; snippet_redacted: string };
    expect(f.entity_type).toBe('US_SSN');
    // Cleartext SSN must not appear in the snippet.
    expect(f.snippet_redacted).not.toContain('123-45-6789');

    // CSV export contains the same row.
    const csv = await request(app)
      .get(`/v1/scan/jobs/${jobId}/findings.csv`)
      .set('Cookie', cookie);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('US_SSN');
    expect(csv.text).toContain('high');
  });

  it('findings filter by severity', async () => {
    const op = await users.create({ email: 'scan-filter@firm.example' });
    await users.setRole(op.id, 'scan', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'scan-filter@firm.example');
    const upload = await request(app)
      .post('/v1/scan/jobs')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('SSN 123-45-6789'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
    const jobId = upload.body.id as string;
    await pollUntilTerminal(app, cookie, jobId);

    // High → the single SSN finding.
    const high = await request(app)
      .get(`/v1/scan/jobs/${jobId}/findings?severity=high`)
      .set('Cookie', cookie);
    expect(high.status).toBe(200);
    expect(high.body).toHaveLength(1);
    // Low → nothing.
    const low = await request(app)
      .get(`/v1/scan/jobs/${jobId}/findings?severity=low`)
      .set('Cookie', cookie);
    expect(low.body).toHaveLength(0);
  });

  it('non-owner gets 404 (existence hidden)', async () => {
    const owner = await users.create({ email: 'scan-owner@firm.example' });
    await users.setRole(owner.id, 'scan', 'operator');
    const ownerCookie = await consumeMagicLink(app, magicLinks, 'scan-owner@firm.example');
    const upload = await request(app)
      .post('/v1/scan/jobs')
      .set('Cookie', ownerCookie)
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
    const jobId = upload.body.id as string;

    const stranger = await users.create({ email: 'scan-stranger@firm.example' });
    await users.setRole(stranger.id, 'scan', 'operator');
    const strangerCookie = await consumeMagicLink(
      app,
      magicLinks,
      'scan-stranger@firm.example',
    );
    const r = await request(app)
      .get(`/v1/scan/jobs/${jobId}`)
      .set('Cookie', strangerCookie);
    expect(r.status).toBe(404);
  });

  it('delete purges the job + findings cascade', async () => {
    const op = await users.create({ email: 'scan-del@firm.example' });
    await users.setRole(op.id, 'scan', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'scan-del@firm.example');
    const upload = await request(app)
      .post('/v1/scan/jobs')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('SSN 123-45-6789'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
    const jobId = upload.body.id as string;
    await pollUntilTerminal(app, cookie, jobId);

    const del = await request(app)
      .delete(`/v1/scan/jobs/${jobId}`)
      .set('Cookie', cookie);
    expect(del.status).toBe(204);

    const after = await request(app)
      .get(`/v1/scan/jobs/${jobId}`)
      .set('Cookie', cookie);
    expect(after.status).toBe(404);
  });

  it('engine failure marks the job failed', async () => {
    const failingEngine = {
      redact: () => Promise.reject(new Error('n/a')),
      analyze: () => Promise.reject(new Error('n/a')),
      health: () => Promise.resolve({ status: 'ok', model_loaded: true }),
      redactImage: () => Promise.reject(new Error('n/a')),
      redactPdf: () => Promise.reject(new Error('n/a')),
      scan: () => Promise.reject(new Error('engine unreachable')),
    } as unknown as EngineClient;
    const failingPipeline = new ScanPipeline({
      jobs,
      engine: failingEngine,
      logger: silent,
    });
    const failApp = createApp({
      db: handle.db,
      apiKeys: new ApiKeyStore(handle.db),
      sessions: new SessionManager(handle.db),
      vault: new TokenVault(handle.db, new StaticKeyResolver()),
      engine: stubEngine(),
      anthropic: stubAnthropic(emptyMessage()),
      logger: silent,
      maxRequestBytes: 32 * 1024 * 1024,
      sessionTtlMinutes: 60,
      adminKey: 'vs-admin-scan-test',
      users,
      userSessions: new UserSessionStore(handle.db, 60),
      magicLinks,
      audit: new AuditLogger(handle.db),
      scanJobs: jobs,
      scanPipeline: failingPipeline,
    });
    const op = await users.create({ email: 'scan-fail@firm.example' });
    await users.setRole(op.id, 'scan', 'operator');
    const cookie = await consumeMagicLink(failApp, magicLinks, 'scan-fail@firm.example');
    const upload = await request(failApp)
      .post('/v1/scan/jobs')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' });
    const jobId = upload.body.id as string;
    const final = await pollUntilTerminal(failApp, cookie, jobId);
    expect(final.status).toBe('failed');
  });
});
