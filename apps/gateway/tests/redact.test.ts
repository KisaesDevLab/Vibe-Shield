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
  RedactJobStore,
  SessionManager,
  TokenVault,
  UserSessionStore,
  UserStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import { createApp } from '../src/app.js';
import { SESSION_COOKIE_NAME } from '../src/auth/cookie.js';
import type { EngineClient, RedactImageResponse } from '../src/engine/client.js';
import { RedactPipeline } from '../src/redact/pipeline.js';
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

function makeEngineStub(canned: RedactImageResponse): EngineClient {
  return {
    redact: () => Promise.reject(new Error('not used')),
    analyze: () => Promise.reject(new Error('not used')),
    health: () => Promise.resolve({ status: 'ok', model_loaded: true }),
    redactImage: () => Promise.resolve(canned),
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

describe.skipIf(!integrationEnabled)('Redact module (Phase 17 v1.4)', () => {
  let handle: DatabaseHandle;
  let tmpDir: string;
  let storage: JobStorage;
  let users: UserStore;
  let magicLinks: MagicLinkStore;
  let jobs: RedactJobStore;
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
      .attach('file', Buffer.from('not a real pdf'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('PDF lands in v1.5');
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
