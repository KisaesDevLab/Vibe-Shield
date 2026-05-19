/**
 * Redact module — Phase 17 v1.4 end-to-end tests.
 *
 * Exercises the full upload → pipeline → status → download flow
 * against a real Postgres (DATABASE_URL gates) with a stubbed engine
 * client (we don't run the Python container locally). Confirms:
 *   - RBAC gates work (no role, viewer-only, operator+)
 *   - Multipart upload is parsed correctly
 *   - Engine response is persisted to disk + DB
 *   - Artifacts download with the right MIME + filename
 *   - Job ownership filters (non-admin users can't see others' jobs)
 *   - DELETE purges the on-disk directory + the DB row
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import {
  ApiKeyStore,
  AuditLogger,
  MagicLinkStore,
  RedactBatchStore,
  RedactJobStore,
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
  RedactImageResponse,
  RedactPdfResponse,
} from '../src/engine/client.js';
import { RedactJobEvents } from '../src/redact/job-events.js';
import { RedactPipeline } from '../src/redact/pipeline.js';
import { RedactPurgeCron } from '../src/redact/purge-cron.js';
import { JobStorage } from '../src/redact/storage.js';
import {
  emptyMessage,
  freshDatabase,
  integrationEnabled,
  StaticKeyResolver,
  stubAnthropic,
  stubEngine,
} from './setup.js';

const silent = pino({ level: 'silent' });

const SAMPLE_PNG = Buffer.from(
  // Minimal valid 1×1 PNG (transparent).
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

function makeEngineStub(
  canned: RedactImageResponse,
  pdfCanned?: RedactPdfResponse,
): EngineClient {
  return {
    redact: () => Promise.reject(new Error('not used')),
    analyze: () => Promise.reject(new Error('not used')),
    health: () => Promise.resolve({ status: 'ok', model_loaded: true }),
    redactImage: () => Promise.resolve(canned),
    // v1.6 — the pipeline now consumes per-page events via onPage,
    // so the stub fires the callback per page (synchronously) before
    // resolving with the aggregated response. Matches the real
    // streaming client's contract.
    redactPdf: (
      _bytes: Buffer,
      opts: { onPage?: (p: import('../src/engine/client.js').RedactPdfPage) => void } = {},
    ) => {
      if (pdfCanned === undefined) {
        return Promise.reject(new Error('no PDF stub'));
      }
      if (opts.onPage !== undefined) {
        for (const page of pdfCanned.pages) {
          opts.onPage(page);
        }
      }
      return Promise.resolve(pdfCanned);
    },
  } as unknown as EngineClient;
}

const DEFAULT_ENGINE_RESP: RedactImageResponse = {
  image_sha256: 'a'.repeat(64),
  masked_image_sha256: 'b'.repeat(64),
  masked_image_base64: SAMPLE_PNG.toString('base64'),
  redacted_text: 'Hello <PERSON_1>, your SSN is <US_SSN_1>.',
  tokens: [
    { token: '<PERSON_1>', entity_type: 'PERSON', cleartext: 'Alice Doe' },
    { token: '<US_SSN_1>', entity_type: 'US_SSN', cleartext: '123-45-6789' },
  ],
  masked_regions: [
    { entity_type: 'PERSON', token: '<PERSON_1>', x: 10, y: 20, width: 100, height: 30 },
    { entity_type: 'US_SSN', token: '<US_SSN_1>', x: 10, y: 60, width: 80, height: 30 },
  ],
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

describe.skipIf(!integrationEnabled)('Redact module (Phase 17 v1.4–v1.6)', () => {
  let handle: DatabaseHandle;
  let tmpDir: string;
  let storage: JobStorage;
  let users: UserStore;
  let magicLinks: MagicLinkStore;
  let jobs: RedactJobStore;
  let batches: RedactBatchStore;
  let engine: EngineClient;
  let pipeline: RedactPipeline;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await freshDatabase();
    tmpDir = await mkdtemp(join(tmpdir(), 'vs-redact-tests-'));
    storage = new JobStorage({ baseDir: tmpDir });
    users = new UserStore(handle.db);
    magicLinks = new MagicLinkStore(handle.db, 15);
    jobs = new RedactJobStore(handle.db);
    batches = new RedactBatchStore(handle.db);
    engine = makeEngineStub(DEFAULT_ENGINE_RESP);
    pipeline = new RedactPipeline({
      jobs,
      engine,
      storage,
      audit: new AuditLogger(handle.db),
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
      adminKey: 'vs-admin-redact-test',
      users,
      userSessions: new UserSessionStore(handle.db, 60),
      magicLinks,
      audit: new AuditLogger(handle.db),
      redactJobs: jobs,
      redactStorage: storage,
      redactPipeline: pipeline,
      redactBatches: batches,
      redactMaxUploadBytes: 25 * 1024 * 1024,
    });
  });

  afterAll(async () => {
    await handle.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Wipe any uploaded jobs between tests; we rely on UUID isolation
    // for users but artifacts on disk would pile up.
  });

  it('rejects upload without a session', async () => {
    const r = await request(app)
      .post('/v1/redact/jobs')
      .attach('file', SAMPLE_PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(401);
  });

  it('rejects upload when the user has no redact role', async () => {
    await users.create({ email: 'noredact@firm.example' });
    const cookie = await consumeMagicLink(app, magicLinks, 'noredact@firm.example');
    const r = await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', SAMPLE_PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(403);
  });

  it('upload + persist + download end-to-end', async () => {
    const user = await users.create({ email: 'redact-op@firm.example' });
    await users.setRole(user.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'redact-op@firm.example');

    const upload = await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', SAMPLE_PNG, { filename: 'bank.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.status).toBe('completed');
    expect(upload.body.filename).toBe('bank.png');
    const jobId = upload.body.id as string;

    // Artifacts exist on disk in the expected layout.
    const jobDir = join(tmpDir, jobId);
    const dirStat = await stat(jobDir);
    expect(dirStat.isDirectory()).toBe(true);
    await expect(stat(join(jobDir, 'redacted.pdf'))).resolves.toBeTruthy();
    await expect(stat(join(jobDir, 'extracted.md'))).resolves.toBeTruthy();
    await expect(stat(join(jobDir, 'extracted.json'))).resolves.toBeTruthy();
    await expect(stat(join(jobDir, 'source.png'))).resolves.toBeTruthy();
    await expect(stat(join(jobDir, 'audit.jsonl'))).resolves.toBeTruthy();

    // extracted.md contains the redacted text + the token map.
    const md = await readFile(join(jobDir, 'extracted.md'), 'utf8');
    expect(md).toContain('<PERSON_1>');
    expect(md).toContain('PERSON');

    // Download redacted PDF.
    const dl = await request(app)
      .get(`/v1/redact/jobs/${jobId}/artifacts/redacted`)
      .set('Cookie', cookie);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-disposition']).toContain('bank-redacted.pdf');
    // pdf-lib emits a valid PDF header.
    expect(dl.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('rejects unsupported mime', async () => {
    const user = await users.create({ email: 'reject-mime@firm.example' });
    await users.setRole(user.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'reject-mime@firm.example');
    const r = await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', Buffer.from('PK fake docx'), {
        filename: 'doc.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('unsupported file type');
  });

  it('viewer can list + read own jobs but cannot upload', async () => {
    const op = await users.create({ email: 'viewer-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const opCookie = await consumeMagicLink(app, magicLinks, 'viewer-op@firm.example');
    await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', opCookie)
      .attach('file', SAMPLE_PNG, { filename: 'op.png', contentType: 'image/png' });

    const viewer = await users.create({ email: 'just-viewer@firm.example' });
    await users.setRole(viewer.id, 'redact', 'viewer');
    const viewerCookie = await consumeMagicLink(app, magicLinks, 'just-viewer@firm.example');
    const upload = await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', viewerCookie)
      .attach('file', SAMPLE_PNG, { filename: 'v.png', contentType: 'image/png' });
    expect(upload.status).toBe(403);

    // Viewer's own job list is empty (they own none).
    const myList = await request(app).get('/v1/redact/jobs').set('Cookie', viewerCookie);
    expect(myList.status).toBe(200);
    expect(myList.body).toEqual([]);
  });

  it('org_admin sees all jobs across users', async () => {
    const op = await users.create({ email: 'cross-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const opCookie = await consumeMagicLink(app, magicLinks, 'cross-op@firm.example');
    await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', opCookie)
      .attach('file', SAMPLE_PNG, { filename: 'first.png', contentType: 'image/png' });

    const orgAdmin = await users.create({
      email: 'orgadmin-cross@firm.example',
      isOrgAdmin: true,
    });
    void orgAdmin;
    const oaCookie = await consumeMagicLink(
      app,
      magicLinks,
      'orgadmin-cross@firm.example',
    );
    const list = await request(app).get('/v1/redact/jobs').set('Cookie', oaCookie);
    expect(list.status).toBe(200);
    // At least the op's job is visible.
    expect(
      (list.body as Array<{ filename: string }>).some((j) => j.filename === 'first.png'),
    ).toBe(true);
  });

  it('delete purges disk + DB; download then 404s', async () => {
    const op = await users.create({ email: 'delete-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'delete-op@firm.example');

    const upload = await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', SAMPLE_PNG, { filename: 'todelete.png', contentType: 'image/png' });
    const jobId = upload.body.id as string;
    const jobDir = join(tmpDir, jobId);
    await expect(stat(jobDir)).resolves.toBeTruthy();

    const del = await request(app)
      .delete(`/v1/redact/jobs/${jobId}`)
      .set('Cookie', cookie);
    expect(del.status).toBe(204);

    // Job dir gone.
    await expect(stat(jobDir)).rejects.toHaveProperty('code', 'ENOENT');

    // GET now 404s.
    const detail = await request(app)
      .get(`/v1/redact/jobs/${jobId}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(404);
  });

  it('v1.5: PDF upload runs async and the multi-page artifact is assembled', async () => {
    const pdfPipeline = new RedactPipeline({
      jobs,
      engine: makeEngineStub(DEFAULT_ENGINE_RESP, {
        pdf_sha256: 'c'.repeat(64),
        pages_count: 3,
        pages: [1, 2, 3].map((n) => ({
          page_number: n,
          masked_image_sha256: `m${String(n)}`,
          masked_image_base64: SAMPLE_PNG.toString('base64'),
          redacted_text: `Page ${String(n)} content with <PERSON_1>.`,
          tokens: [
            { token: '<PERSON_1>', entity_type: 'PERSON', cleartext: 'Alice' },
          ],
          masked_regions: [
            { entity_type: 'PERSON', token: '<PERSON_1>', x: 0, y: 0, width: 10, height: 10 },
          ],
        })),
        tokens_concatenated: [
          { token: '<PERSON_1>', entity_type: 'PERSON', cleartext: 'Alice' },
          { token: '<PERSON_1>', entity_type: 'PERSON', cleartext: 'Bob' },
          { token: '<PERSON_1>', entity_type: 'PERSON', cleartext: 'Carol' },
        ],
      }),
      storage,
      audit: new AuditLogger(handle.db),
      logger: silent,
    });
    const pdfApp = createApp({
      db: handle.db,
      apiKeys: new ApiKeyStore(handle.db),
      sessions: new SessionManager(handle.db),
      vault: new TokenVault(handle.db, new StaticKeyResolver()),
      engine: stubEngine(),
      anthropic: stubAnthropic(emptyMessage()),
      logger: silent,
      maxRequestBytes: 64 * 1024 * 1024,
      sessionTtlMinutes: 60,
      adminKey: 'vs-admin-redact-test',
      users,
      userSessions: new UserSessionStore(handle.db, 60),
      magicLinks,
      audit: new AuditLogger(handle.db),
      redactJobs: jobs,
      redactStorage: storage,
      redactPipeline: pdfPipeline,
      redactMaxUploadBytes: 50 * 1024 * 1024,
    });
    const op = await users.create({ email: 'pdf-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(pdfApp, magicLinks, 'pdf-op@firm.example');
    const pdfBytes = Buffer.from('%PDF-1.4 fake', 'utf8');
    const r = await request(pdfApp)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', pdfBytes, { filename: 'statement.pdf', contentType: 'application/pdf' });
    // 202 immediately, because PDFs go through the async path.
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('pending');
    const jobId = r.body.id as string;
    // The async pipeline completes within a few hundred ms because
    // the engine is stubbed.
    let final = r.body;
    for (let i = 0; i < 30; i++) {
      const detail = await request(pdfApp)
        .get(`/v1/redact/jobs/${jobId}`)
        .set('Cookie', cookie);
      final = detail.body;
      if (final.status === 'completed' || final.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(final.status).toBe('completed');
    expect(final.pages_count).toBe(3);

    // Confirm the assembled redacted PDF has 3 pages (pdf-lib will
    // emit a valid PDF). Quick assertion: file > 1KB.
    const dl = await request(pdfApp)
      .get(`/v1/redact/jobs/${jobId}/artifacts/redacted`)
      .set('Cookie', cookie);
    expect(dl.status).toBe(200);
    expect(dl.body.length).toBeGreaterThan(1024);
    expect(dl.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('v1.5: purge cron removes expired completed jobs + their dirs', async () => {
    const op = await users.create({ email: 'purge-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'purge-op@firm.example');
    const upload = await request(app)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', SAMPLE_PNG, { filename: 'forpurge.png', contentType: 'image/png' });
    const jobId = upload.body.id as string;
    const jobDir = join(tmpDir, jobId);
    await expect(stat(jobDir)).resolves.toBeTruthy();

    // Force-expire it.
    await handle.client`UPDATE vs_redact_jobs SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${jobId}`;

    const cron = new RedactPurgeCron({
      jobs,
      storage,
      logger: silent,
      intervalMs: 0,
    });
    const cleaned = await cron.runOnce();
    expect(cleaned).toBeGreaterThanOrEqual(1);
    await expect(stat(jobDir)).rejects.toHaveProperty('code', 'ENOENT');

    const after = await request(app)
      .get(`/v1/redact/jobs/${jobId}`)
      .set('Cookie', cookie);
    expect(after.status).toBe(404);
  });

  it('v1.5: SSE stream replays snapshot for completed job + closes', async () => {
    const events = new RedactJobEvents();
    const sseApp = createApp({
      db: handle.db,
      apiKeys: new ApiKeyStore(handle.db),
      sessions: new SessionManager(handle.db),
      vault: new TokenVault(handle.db, new StaticKeyResolver()),
      engine: stubEngine(),
      anthropic: stubAnthropic(emptyMessage()),
      logger: silent,
      maxRequestBytes: 64 * 1024 * 1024,
      sessionTtlMinutes: 60,
      adminKey: 'vs-admin-redact-test',
      users,
      userSessions: new UserSessionStore(handle.db, 60),
      magicLinks,
      audit: new AuditLogger(handle.db),
      redactJobs: jobs,
      redactStorage: storage,
      redactPipeline: pipeline,
      redactEvents: events,
      redactMaxUploadBytes: 50 * 1024 * 1024,
    });
    const op = await users.create({ email: 'sse-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(sseApp, magicLinks, 'sse-op@firm.example');
    const upload = await request(sseApp)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', SAMPLE_PNG, { filename: 'sse.png', contentType: 'image/png' });
    const jobId = upload.body.id as string;

    const sse = await request(sseApp)
      .get(`/v1/redact/jobs/${jobId}/stream`)
      .set('Cookie', cookie)
      .buffer(true);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.text).toContain('event: snapshot');
    // Completed-on-arrival → terminal job_completed event included.
    expect(sse.text).toContain('event: job_completed');
  });

  it('v1.6: bulk upload creates a batch + N jobs sharing batch_id', async () => {
    const op = await users.create({ email: 'bulk-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(app, magicLinks, 'bulk-op@firm.example');

    const r = await request(app)
      .post('/v1/redact/batches')
      .set('Cookie', cookie)
      .field('name', 'Q1 client batch')
      .attach('files', SAMPLE_PNG, { filename: 'one.png', contentType: 'image/png' })
      .attach('files', SAMPLE_PNG, { filename: 'two.png', contentType: 'image/png' })
      .attach('files', SAMPLE_PNG, { filename: 'three.png', contentType: 'image/png' });
    expect(r.status).toBe(202);
    expect(r.body.batch.total_jobs).toBe(3);
    expect(r.body.batch.name).toBe('Q1 client batch');
    expect(r.body.jobs).toHaveLength(3);
    const batchId = r.body.batch.id as string;
    for (const job of r.body.jobs as { batch_id: string }[]) {
      expect(job.batch_id).toBe(batchId);
    }

    // Sequential drain finishes within a second for stubbed engine.
    let summary = { completed: 0, failed: 0, pending: 0, running: 0 };
    for (let i = 0; i < 30; i++) {
      const det = await request(app)
        .get(`/v1/redact/batches/${batchId}`)
        .set('Cookie', cookie);
      summary = det.body.summary as typeof summary;
      if (summary.completed + summary.failed === 3) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(summary.completed).toBe(3);
  });

  it('v1.6: non-owner cannot read another user\'s batch (returns 404 to hide existence)', async () => {
    const owner = await users.create({ email: 'batch-owner@firm.example' });
    await users.setRole(owner.id, 'redact', 'operator');
    const ownerCookie = await consumeMagicLink(app, magicLinks, 'batch-owner@firm.example');
    const created = await request(app)
      .post('/v1/redact/batches')
      .set('Cookie', ownerCookie)
      .attach('files', SAMPLE_PNG, { filename: 'a.png', contentType: 'image/png' });
    const batchId = created.body.batch.id as string;

    const stranger = await users.create({ email: 'stranger@firm.example' });
    await users.setRole(stranger.id, 'redact', 'operator');
    const strangerCookie = await consumeMagicLink(app, magicLinks, 'stranger@firm.example');
    const r = await request(app)
      .get(`/v1/redact/batches/${batchId}`)
      .set('Cookie', strangerCookie);
    expect(r.status).toBe(404);
  });

  it('v1.6: streaming /redact-pdf consumer aggregates pages and yields each via onPage', async () => {
    // Construct a real EngineClient against a stub fetch that emits
    // NDJSON chunks with a tiny delay between pages.
    const ndjsonLines = [
      JSON.stringify({
        type: 'page',
        page_number: 1,
        total_pages: 2,
        masked_image_sha256: 'p1',
        masked_image_base64: SAMPLE_PNG.toString('base64'),
        redacted_text: 'first',
        tokens: [],
        masked_regions: [],
      }) + '\n',
      JSON.stringify({
        type: 'page',
        page_number: 2,
        total_pages: 2,
        masked_image_sha256: 'p2',
        masked_image_base64: SAMPLE_PNG.toString('base64'),
        redacted_text: 'second',
        tokens: [],
        masked_regions: [],
      }) + '\n',
      JSON.stringify({
        type: 'summary',
        pdf_sha256: 'abc',
        pages_count: 2,
        tokens_concatenated: [],
      }) + '\n',
    ];
    const fakeFetch: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const line of ndjsonLines) {
            controller.enqueue(encoder.encode(line));
            await new Promise((res) => setTimeout(res, 10));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    };
    const { EngineClient } = await import('../src/engine/client.js');
    const ec = new EngineClient({ baseUrl: 'http://fake', fetchImpl: fakeFetch });
    const pagesSeen: number[] = [];
    const resp = await ec.redactPdf(Buffer.from('%PDF-1.4'), {
      onPage: (p) => pagesSeen.push(p.page_number),
    });
    expect(pagesSeen).toEqual([1, 2]);
    expect(resp.pages_count).toBe(2);
    expect(resp.pdf_sha256).toBe('abc');
  });

  it('engine failure marks the job failed and surfaces the error', async () => {
    const failingPipeline = new RedactPipeline({
      jobs,
      engine: {
        redact: () => Promise.reject(new Error('not used')),
        analyze: () => Promise.reject(new Error('not used')),
        health: () => Promise.resolve({ status: 'ok', model_loaded: true }),
        redactImage: () => Promise.reject(new Error('engine unreachable')),
      } as unknown as EngineClient,
      storage,
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
      adminKey: 'vs-admin-redact-test',
      users,
      userSessions: new UserSessionStore(handle.db, 60),
      magicLinks,
      audit: new AuditLogger(handle.db),
      redactJobs: jobs,
      redactStorage: storage,
      redactPipeline: failingPipeline,
      redactMaxUploadBytes: 25 * 1024 * 1024,
    });
    const op = await users.create({ email: 'fail-op@firm.example' });
    await users.setRole(op.id, 'redact', 'operator');
    const cookie = await consumeMagicLink(failApp, magicLinks, 'fail-op@firm.example');
    const r = await request(failApp)
      .post('/v1/redact/jobs')
      .set('Cookie', cookie)
      .attach('file', SAMPLE_PNG, { filename: 'fail.png', contentType: 'image/png' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('failed');
    expect(r.body.error_message).toContain('engine unreachable');
  });
});
