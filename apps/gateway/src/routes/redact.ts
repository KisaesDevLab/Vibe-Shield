/**
 * /v1/redact/* — Phase D / Phase 17 v1.4 user-facing Redact module.
 *
 * Endpoints (all behind ``requires('redact', <role>)``):
 *   POST   /v1/redact/jobs                          — upload + run (operator+)
 *   GET    /v1/redact/jobs                          — list my jobs (viewer+)
 *   GET    /v1/redact/jobs/:id                      — job detail (viewer+)
 *   GET    /v1/redact/jobs/:id/artifacts/:kind      — download artifact (viewer+)
 *   DELETE /v1/redact/jobs/:id                      — purge job + artifacts (operator+)
 *
 * The DELETE soft-deletes by purging the on-disk directory and the
 * DB row. Org-admins can purge any job; everyone else can only purge
 * their own.
 *
 * The upload path is synchronous: small images (default ≤ 25 MB) get
 * the full pipeline + response in one HTTP round-trip. Async + SSE +
 * multi-page PDF support ship in v1.5.
 */

import { Router } from 'express';
import multer from 'multer';
import type { Logger } from 'pino';
import {
  RedactJobNotFoundError,
  type RedactJobRecord,
  type RedactJobStore,
} from '@kisaesdevlab/vibe-shield-schema';
import {
  AuthenticationError,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
} from '../errors.js';
import type { RedactPipeline } from '../redact/pipeline.js';
import {
  ArtifactNotFoundError,
  InvalidJobIdError,
  JobStorage,
  type ArtifactKind,
} from '../redact/storage.js';
import type { RedactJobEvents } from '../redact/job-events.js';

export interface RedactRoutesDeps {
  jobs: RedactJobStore;
  storage: JobStorage;
  pipeline: RedactPipeline;
  logger: Logger;
  /** Per-upload byte cap. Default 25 MB. */
  maxUploadBytes?: number;
  /** v1.5 — event broker for SSE progress. Optional in tests. */
  events?: RedactJobEvents;
  /** v1.5 — sync threshold. Anything at-or-below runs sync (HTTP
   *  waits for the result); anything above returns 201 immediately
   *  and runs in the background. PDFs always run async. Default 1
   *  (single-image always sync; PDFs always async). */
  syncMaxPages?: number;
}

/** Whitelist of source MIME types. v1.5 adds application/pdf. */
const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'application/pdf',
]);

const ARTIFACT_KINDS: Set<ArtifactKind> = new Set([
  'source',
  'redacted',
  'extracted_md',
  'extracted_json',
]);

export function redactRouter(deps: RedactRoutesDeps): Router {
  const router: Router = Router();
  const maxUploadBytes = deps.maxUploadBytes ?? 25 * 1024 * 1024;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1 },
  });

  router.post('/v1/redact/jobs', upload.single('file'), (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) {
          throw new AuthenticationError('sign-in required');
        }
        if (!hasRedactRole(req.user, 'operator')) {
          throw new PermissionError('redact operator role required');
        }
        const file = (req as { file?: Express.Multer.File }).file;
        if (file === undefined) {
          throw new InvalidRequestError('file is required (multipart field "file")');
        }
        if (!ALLOWED_MIMES.has(file.mimetype)) {
          throw new InvalidRequestError(
            `unsupported file type: ${file.mimetype}. Accepts PNG/JPEG/WebP/TIFF/BMP/PDF.`,
          );
        }
        const filename = sanitizeFilename(file.originalname);
        const ext = JobStorage.safeExt(filename);

        const job = await deps.jobs.create({
          userId: req.user.id,
          filename,
          mime: file.mimetype,
          sourceSizeBytes: file.size,
        });

        // v1.5: PDFs always async (page count can be high; sync HTTP
        // would block the connection for minutes). Images always sync
        // (one engine call, ~5-15s). The SPA polls or subscribes to
        // /stream for async jobs.
        const isAsync = file.mimetype === 'application/pdf';

        if (isAsync) {
          // Fire-and-forget; the pipeline captures any failure into
          // the row. The route returns the pending record immediately.
          void deps.pipeline
            .run(
              job,
              file.buffer,
              ext,
              req.header('x-correlation-id') ?? undefined,
            )
            .catch(() => undefined);
          res.status(202).json(jobToWire(job));
          return;
        }

        const finished = await deps.pipeline.run(
          job,
          file.buffer,
          ext,
          req.header('x-correlation-id') ?? undefined,
        );
        res.status(201).json(jobToWire(finished));
      } catch (err) {
        next(err);
      }
    })();
  });

  // v1.5 — SSE progress stream. Connect after upload to watch a PDF
  // job complete page by page.
  router.get('/v1/redact/jobs/:id/stream', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasRedactRole(req.user, 'viewer')) {
          throw new PermissionError('redact viewer role required');
        }
        if (deps.events === undefined) {
          throw new InvalidRequestError('SSE stream not configured on this deployment');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        res.flushHeaders();

        const send = (event: { type: string; data: unknown }): void => {
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event.data)}\n\n`);
        };

        // Replay current state so a late subscriber sees what's
        // already known. We DON'T replay events — we just sync the
        // current status. The next live event progresses from there.
        send({
          type: 'snapshot',
          data: {
            job_id: job.id,
            status: job.status,
            pages_count: job.pagesCount,
          },
        });

        if (job.status === 'completed' || job.status === 'failed') {
          send({
            type: job.status === 'completed' ? 'job_completed' : 'job_failed',
            data: {
              job_id: job.id,
              error_message: job.errorMessage,
            },
          });
          res.end();
          return;
        }

        const unsubscribe = deps.events.subscribe(job.id, (event) => {
          send({ type: event.type, data: event });
          if (event.type === 'job_completed' || event.type === 'job_failed') {
            // Close the stream after the terminal event so the
            // browser's EventSource doesn't auto-reconnect.
            setTimeout(() => res.end(), 50);
          }
        });

        // Heartbeat every 30s so intermediaries don't tear down the
        // connection on idle.
        const heartbeat = setInterval(() => {
          res.write(': heartbeat\n\n');
        }, 30_000);
        heartbeat.unref();

        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/redact/jobs', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) {
          throw new AuthenticationError('sign-in required');
        }
        if (!hasRedactRole(req.user, 'viewer')) {
          throw new PermissionError('redact viewer role required');
        }
        const limitRaw =
          typeof req.query['limit'] === 'string'
            ? Number(req.query['limit'])
            : undefined;
        const limit =
          limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : 50;
        // Org admins + redact admins see every job; everyone else
        // sees only their own.
        const list = isOrgAdminOrRedactAdmin(req.user)
          ? await deps.jobs.listAll(limit)
          : await deps.jobs.listForUser(req.user.id, limit);
        res.json(list.map(jobToWire));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/redact/jobs/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasRedactRole(req.user, 'viewer')) {
          throw new PermissionError('redact viewer role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        res.json(jobToWire(job));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/redact/jobs/:id/artifacts/:kind', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasRedactRole(req.user, 'viewer')) {
          throw new PermissionError('redact viewer role required');
        }
        const id = req.params.id ?? '';
        const kindRaw = req.params.kind ?? '';
        if (!ARTIFACT_KINDS.has(kindRaw as ArtifactKind)) {
          throw new InvalidRequestError(
            `unknown artifact kind: ${kindRaw}. Valid: ${Array.from(ARTIFACT_KINDS).join(', ')}`,
          );
        }
        const kind = kindRaw as ArtifactKind;
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        if (job.status !== 'completed' && kind !== 'source') {
          throw new InvalidRequestError(
            `artifact ${kind} not available — job status is ${job.status}`,
          );
        }
        const sourceExt =
          kind === 'source' ? JobStorage.safeExt(job.filename) : undefined;
        const stats = await deps.storage.artifactStat(job.id, kind, sourceExt);
        const downloadName = downloadFilename(job, kind);
        const mime = deps.storage.artifactMime(
          kind,
          kind === 'source' ? job.mime : undefined,
        );
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', stats.size.toString());
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${downloadName}"`,
        );
        const stream = deps.storage.artifactStream(job.id, kind, sourceExt);
        stream.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            next(new NotFoundError('artifact not found'));
            return;
          }
          next(err);
        });
        stream.pipe(res);
      } catch (err) {
        if (err instanceof ArtifactNotFoundError) {
          next(new NotFoundError('artifact not found'));
          return;
        }
        if (err instanceof InvalidJobIdError) {
          next(new InvalidRequestError('invalid job id'));
          return;
        }
        next(err);
      }
    })();
  });

  router.delete('/v1/redact/jobs/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasRedactRole(req.user, 'operator')) {
          throw new PermissionError('redact operator role required to delete');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        await deps.storage.purgeJob(job.id).catch(() => undefined);
        await deps.jobs.delete(job.id);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

function jobToWire(j: RedactJobRecord) {
  return {
    id: j.id,
    user_id: j.userId,
    filename: j.filename,
    mime: j.mime,
    source_size_bytes: j.sourceSizeBytes,
    pages_count: j.pagesCount,
    status: j.status,
    error_message: j.errorMessage,
    created_at: j.createdAt.toISOString(),
    started_at: j.startedAt?.toISOString() ?? null,
    finished_at: j.finishedAt?.toISOString() ?? null,
    expires_at: j.expiresAt.toISOString(),
  };
}

function hasRedactRole(
  user: NonNullable<Express.Request['user']>,
  min: 'viewer' | 'operator' | 'admin',
): boolean {
  if (user.isOrgAdmin) return true;
  const have = user.roles.redact;
  if (have === undefined) return false;
  const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
  return (rank[have] ?? 0) >= rank[min]!;
}

function isOrgAdminOrRedactAdmin(
  user: NonNullable<Express.Request['user']>,
): boolean {
  return user.isOrgAdmin || user.roles.redact === 'admin';
}

async function fetchOwnedJob(
  store: RedactJobStore,
  id: string,
  user: NonNullable<Express.Request['user']>,
): Promise<RedactJobRecord> {
  let job: RedactJobRecord | null;
  try {
    job = await store.findById(id);
  } catch (err) {
    if (err instanceof RedactJobNotFoundError) {
      throw new NotFoundError('redact job');
    }
    throw err;
  }
  if (job === null) {
    throw new NotFoundError('redact job');
  }
  // Org admins + redact admins see everyone's jobs; everyone else
  // is restricted to their own.
  if (!isOrgAdminOrRedactAdmin(user) && job.userId !== user.id) {
    throw new NotFoundError('redact job');
  }
  return job;
}

const FILENAME_SANITIZE = /[^A-Za-z0-9._-]/g;
function sanitizeFilename(name: string): string {
  const trimmed = (name || 'upload').slice(-200).replace(FILENAME_SANITIZE, '_');
  return trimmed.length > 0 ? trimmed : 'upload';
}

function downloadFilename(job: RedactJobRecord, kind: ArtifactKind): string {
  const base = job.filename.replace(/\.[^.]+$/, '');
  switch (kind) {
    case 'source':
      return job.filename;
    case 'redacted':
      return `${base}-redacted.pdf`;
    case 'extracted_md':
      return `${base}-extracted.md`;
    case 'extracted_json':
      return `${base}-extracted.json`;
    case 'audit_jsonl':
      return `${base}-audit.jsonl`;
  }
}
