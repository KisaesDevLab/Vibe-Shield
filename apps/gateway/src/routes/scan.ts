/**
 * /v1/scan/* — Phase 26 (v1.8 foundation).
 *
 * Endpoints (RBAC via ``requires('scan', <role>)``):
 *   POST   /v1/scan/jobs                       upload + scan (operator+)
 *   GET    /v1/scan/jobs                       list my jobs (viewer+)
 *   GET    /v1/scan/jobs/:id                   job detail (viewer+)
 *   GET    /v1/scan/jobs/:id/stream            SSE progress (viewer+)
 *   GET    /v1/scan/jobs/:id/files             list files inside the scan (viewer+)
 *   GET    /v1/scan/jobs/:id/findings          list findings w/ filters (viewer+)
 *   GET    /v1/scan/jobs/:id/findings.csv      CSV export (viewer+)
 *   DELETE /v1/scan/jobs/:id                   purge (operator+)
 *
 * The upload always runs async: even a single CSV with ~thousands of
 * findings is faster than the HTTP round-trip but a zip-of-PDFs can
 * take minutes. Frontend subscribes to /stream for live progress.
 */

import { Router } from 'express';
import multer from 'multer';
import type { Logger } from 'pino';
import {
  ScanJobNotFoundError,
  type AuditLogger,
  type RedactJobStore,
  type ScanJobRecord,
  type ScanJobStore,
  type ScanSeverity,
} from '@kisaesdevlab/vibe-shield-schema';
import {
  AuthenticationError,
  InvalidRequestError,
  NotFoundError,
  NotImplementedError,
  PermissionError,
} from '../errors.js';
import type { ScanPipeline } from '../scan/pipeline.js';
import type { ScanJobEvents } from '../scan/job-events.js';
import type { RedactPipeline } from '../redact/pipeline.js';
import type { JobStorage } from '../redact/storage.js';

export interface ScanRoutesDeps {
  jobs: ScanJobStore;
  pipeline: ScanPipeline;
  logger: Logger;
  events?: ScanJobEvents;
  /** Per-upload byte cap. Default 100 MB (matches the engine cap for
   *  inner files; archives can carry up to 1 GB uncompressed). */
  maxUploadBytes?: number;
  /** v1.9 — bulk-redact integration. When set, POST
   *  /v1/scan/jobs/:id/redact creates one Redact job per flagged
   *  file via the (path-aware) ScanFileFetcher. */
  redactJobs?: RedactJobStore;
  redactPipeline?: RedactPipeline;
  redactStorage?: JobStorage;
  /** v1.9 — caller-side fetcher that turns a vs_scan_files row's path
   *  into the raw bytes the Redact pipeline needs. For v1.9 we only
   *  support filesystem-rooted scheduled scans, so the implementation
   *  reads from the appliance scheduler-root. Tests inject a stub. */
  scanFileFetcher?: ScanFileFetcher;
  /** v1.9 — for suppression audit rows. */
  audit?: AuditLogger;
}

/**
 * v1.9 — turns a stored ``vs_scan_files.path`` plus the parent
 * scan-job context into the raw bytes the bulk-redact endpoint can
 * hand to the Redact pipeline. Returns null when the source isn't
 * available (one-shot uploads aren't persisted on disk; only
 * filesystem-scoped scheduled scans are).
 */
export interface ScanFileFetcher {
  fetch(args: {
    jobId: string;
    filePath: string;
  }): Promise<{ bytes: Buffer; mime: string; filename: string } | null>;
}

const ALLOWED_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/json',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

export function scanRouter(deps: ScanRoutesDeps): Router {
  const router: Router = Router();
  const maxUploadBytes = deps.maxUploadBytes ?? 100 * 1024 * 1024;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1 },
  });

  router.post('/v1/scan/jobs', upload.single('file'), (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const file = (req as { file?: Express.Multer.File }).file;
        if (file === undefined) {
          throw new InvalidRequestError('file is required (multipart field "file")');
        }
        if (!ALLOWED_MIMES.has(file.mimetype) && !file.mimetype.startsWith('text/')) {
          throw new InvalidRequestError(
            `unsupported file type: ${file.mimetype}. Accepts text/*, CSV, JSON, PDF, XLSX, or ZIP.`,
          );
        }
        const filename = sanitizeFilename(file.originalname);
        const sourceKind: 'file' | 'archive' =
          file.mimetype === 'application/zip' ||
          file.mimetype === 'application/x-zip-compressed' ||
          filename.toLowerCase().endsWith('.zip')
            ? 'archive'
            : 'file';

        const job = await deps.jobs.create({
          userId: req.user.id,
          sourceKind,
          sourceName: filename,
          sourceMime: file.mimetype,
          sourceSizeBytes: file.size,
        });

        // Always async — even a small CSV with many findings is
        // chatty against the engine stream. The SPA polls
        // /v1/scan/jobs/:id and/or subscribes to /stream.
        void deps.pipeline
          .run(job, file.buffer, req.header('x-correlation-id') ?? undefined)
          .catch(() => undefined);
        res.status(202).json(jobToWire(job));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const limitRaw =
          typeof req.query['limit'] === 'string'
            ? Number(req.query['limit'])
            : undefined;
        const limit =
          limitRaw !== undefined && Number.isFinite(limitRaw) ? limitRaw : 50;
        const list = isOrgAdminOrScanAdmin(req.user)
          ? await deps.jobs.listAll(limit)
          : await deps.jobs.listForUser(req.user.id, limit);
        res.json(list.map(jobToWire));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        res.json(jobToWire(job));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs/:id/files', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        const files = await deps.jobs.listFiles(job.id);
        res.json(
          files.map((f) => ({
            id: f.id,
            path: f.path,
            mime: f.mime,
            size_bytes: f.sizeBytes,
            sha256: f.sha256,
            skipped_reason: f.skippedReason,
            created_at: f.createdAt.toISOString(),
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs/:id/findings', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        const severity = parseSeverity(req.query['severity']);
        const entityType =
          typeof req.query['entity_type'] === 'string'
            ? req.query['entity_type']
            : undefined;
        const includeSuppressed = req.query['include_suppressed'] === 'true';
        const limit = parseIntQuery(req.query['limit'], 200);
        const offset = parseIntQuery(req.query['offset'], 0);
        const findings = await deps.jobs.listFindings(job.id, {
          ...(severity !== undefined ? { severity } : {}),
          ...(entityType !== undefined ? { entityType } : {}),
          includeSuppressed,
          limit,
          offset,
        });
        res.json(findings.map(findingToWire));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs/:id/findings.csv', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        const findings = await deps.jobs.listFindings(job.id, { limit: 1000 });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="scan-${job.id.slice(0, 8)}-findings.csv"`,
        );
        res.write(
          'entity_type,severity,location,snippet_redacted,sample_hash\n',
        );
        for (const f of findings) {
          res.write(
            [
              csvField(f.entityType),
              csvField(f.severity),
              csvField(f.location),
              csvField(f.snippetRedacted),
              csvField(f.sampleHash),
            ].join(',') + '\n',
          );
        }
        res.end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs/:id/stream', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        if (deps.events === undefined) {
          throw new InvalidRequestError('SSE stream not configured on this deployment');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const send = (event: { type: string; data: unknown }): void => {
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event.data)}\n\n`);
        };

        send({
          type: 'snapshot',
          data: {
            job_id: job.id,
            status: job.status,
            files_count: job.filesCount,
            findings_count: job.findingsCount,
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
            setTimeout(() => res.end(), 50);
          }
        });

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

  // v1.9 — suppress / unsuppress a single finding.
  router.put('/v1/scan/findings/:id/suppress', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const findingId = req.params.id ?? '';
        const finding = await deps.jobs.findFindingById(findingId);
        if (finding === null) throw new NotFoundError('finding');
        // Owner / admin gate via the parent job.
        const job = await fetchOwnedJob(deps.jobs, finding.jobId, req.user);
        const reason = typeof req.body === 'object' && req.body !== null
          ? sanitizeReason((req.body as { reason?: unknown }).reason)
          : null;
        const updated = await deps.jobs.setFindingSuppressed(
          findingId,
          true,
          { userId: req.user.id, reason },
        );
        if (updated === null) throw new NotFoundError('finding');
        if (deps.audit !== undefined) {
          void deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'request',
              module: 'scan',
              payload: {
                action: 'finding_suppressed',
                scan_job_id: job.id,
                finding_id: findingId,
                user_id: req.user.id,
                reason_provided: reason !== null,
              },
            })
            .catch(() => undefined);
        }
        res.json(findingToWire(updated));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/scan/findings/:id/suppress', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const findingId = req.params.id ?? '';
        const finding = await deps.jobs.findFindingById(findingId);
        if (finding === null) throw new NotFoundError('finding');
        const job = await fetchOwnedJob(deps.jobs, finding.jobId, req.user);
        const updated = await deps.jobs.setFindingSuppressed(
          findingId,
          false,
          { userId: null, reason: null },
        );
        if (updated === null) throw new NotFoundError('finding');
        if (deps.audit !== undefined) {
          void deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'request',
              module: 'scan',
              payload: {
                action: 'finding_unsuppressed',
                scan_job_id: job.id,
                finding_id: findingId,
                user_id: req.user.id,
              },
            })
            .catch(() => undefined);
        }
        res.json(findingToWire(updated));
      } catch (err) {
        next(err);
      }
    })();
  });

  // v1.9 — bulk-redact: one Redact job per flagged file.
  router.post('/v1/scan/jobs/:id/redact', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        if (
          deps.redactJobs === undefined ||
          deps.redactPipeline === undefined ||
          deps.redactStorage === undefined ||
          deps.scanFileFetcher === undefined
        ) {
          throw new NotImplementedError(
            'bulk-redact requires a scan-file fetcher (filesystem-scoped scheduled scans only)',
          );
        }
        const flaggedFiles = await deps.jobs.listFilesWithFindings(job.id);
        if (flaggedFiles.length === 0) {
          res.status(200).json({ created: [], skipped: [] });
          return;
        }
        const created: Array<{ scan_file_id: string; redact_job_id: string; path: string }> = [];
        const skipped: Array<{ path: string; reason: string }> = [];
        for (const { fileId, path } of flaggedFiles) {
          const fetched = await deps.scanFileFetcher.fetch({
            jobId: job.id,
            filePath: path,
          });
          if (fetched === null) {
            skipped.push({ path, reason: 'source no longer available' });
            continue;
          }
          const redactJob = await deps.redactJobs.create({
            userId: req.user.id,
            filename: fetched.filename,
            mime: fetched.mime,
            sourceSizeBytes: fetched.bytes.length,
          });
          await deps.jobs.addRedactLink({
            scanJobId: job.id,
            scanFileId: fileId,
            redactJobId: redactJob.id,
          });
          const ext = extFromPath(fetched.filename);
          // Fire-and-forget — same async pattern as POST /v1/redact/jobs.
          void deps.redactPipeline
            .run(redactJob, fetched.bytes, ext, req.header('x-correlation-id') ?? undefined)
            .catch(() => undefined);
          created.push({ scan_file_id: fileId, redact_job_id: redactJob.id, path });
        }
        if (deps.audit !== undefined) {
          void deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'request',
              module: 'scan',
              payload: {
                action: 'bulk_redact',
                scan_job_id: job.id,
                user_id: req.user.id,
                created_count: created.length,
                skipped_count: skipped.length,
              },
            })
            .catch(() => undefined);
        }
        res.status(202).json({ created, skipped });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/jobs/:id/redact-links', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        const links = await deps.jobs.listRedactLinks(job.id);
        res.json(
          links.map((l) => ({
            id: l.id,
            scan_file_id: l.scanFileId,
            redact_job_id: l.redactJobId,
            created_at: l.createdAt.toISOString(),
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  // v1.9 — compare two scan runs. Returns added / removed /
  // persistent findings keyed by sample_hash.
  router.get('/v1/scan/compare', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const aId = typeof req.query['a'] === 'string' ? req.query['a'] : '';
        const bId = typeof req.query['b'] === 'string' ? req.query['b'] : '';
        if (aId === '' || bId === '') {
          throw new InvalidRequestError('a and b query params are required');
        }
        const a = await fetchOwnedJob(deps.jobs, aId, req.user);
        const b = await fetchOwnedJob(deps.jobs, bId, req.user);
        const [aHashes, bHashes] = await Promise.all([
          deps.jobs.listFindingHashes(a.id),
          deps.jobs.listFindingHashes(b.id),
        ]);
        const aMap = new Map(aHashes.map((h) => [h.sampleHash, h]));
        const bMap = new Map(bHashes.map((h) => [h.sampleHash, h]));
        const added: typeof bHashes = [];
        const removed: typeof aHashes = [];
        const persistent: typeof aHashes = [];
        for (const h of bHashes) {
          if (aMap.has(h.sampleHash)) {
            persistent.push(h);
          } else {
            added.push(h);
          }
        }
        for (const h of aHashes) {
          if (!bMap.has(h.sampleHash)) removed.push(h);
        }
        res.json({
          a: {
            id: a.id,
            source_name: a.sourceName,
            created_at: a.createdAt.toISOString(),
          },
          b: {
            id: b.id,
            source_name: b.sourceName,
            created_at: b.createdAt.toISOString(),
          },
          added: added.map(hashToWire),
          removed: removed.map(hashToWire),
          persistent: persistent.map(hashToWire),
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/scan/jobs/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required to delete');
        }
        const id = req.params.id ?? '';
        const job = await fetchOwnedJob(deps.jobs, id, req.user);
        await deps.jobs.delete(job.id);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

function jobToWire(j: ScanJobRecord) {
  return {
    id: j.id,
    user_id: j.userId,
    source_kind: j.sourceKind,
    source_name: j.sourceName,
    source_mime: j.sourceMime,
    source_size_bytes: j.sourceSizeBytes,
    files_count: j.filesCount,
    findings_count: j.findingsCount,
    findings_high: j.findingsHigh,
    findings_medium: j.findingsMedium,
    findings_low: j.findingsLow,
    status: j.status,
    error_message: j.errorMessage,
    created_at: j.createdAt.toISOString(),
    started_at: j.startedAt?.toISOString() ?? null,
    finished_at: j.finishedAt?.toISOString() ?? null,
    expires_at: j.expiresAt.toISOString(),
  };
}

function findingToWire(
  f: import('@kisaesdevlab/vibe-shield-schema').ScanFindingRecord,
) {
  return {
    id: f.id,
    job_id: f.jobId,
    file_id: f.fileId,
    entity_type: f.entityType,
    severity: f.severity,
    location: f.location,
    snippet_redacted: f.snippetRedacted,
    sample_hash: f.sampleHash,
    suppressed: f.suppressed,
    suppressed_by: f.suppressedBy,
    suppressed_at: f.suppressedAt?.toISOString() ?? null,
    suppressed_reason: f.suppressedReason,
    created_at: f.createdAt.toISOString(),
  };
}

function hashToWire(h: {
  sampleHash: string;
  entityType: string;
  severity: 'low' | 'medium' | 'high';
  path: string;
}) {
  return {
    sample_hash: h.sampleHash,
    entity_type: h.entityType,
    severity: h.severity,
    path: h.path,
  };
}

function sanitizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 500);
  return trimmed.length === 0 ? null : trimmed;
}

function extFromPath(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (m === null) return 'bin';
  return m[1]!.toLowerCase();
}

function parseSeverity(raw: unknown): ScanSeverity | undefined {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

function parseIntQuery(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function csvField(s: string): string {
  if (s === '') return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function hasScanRole(
  user: NonNullable<Express.Request['user']>,
  min: 'viewer' | 'operator' | 'admin',
): boolean {
  if (user.isOrgAdmin) return true;
  const have = user.roles.scan;
  if (have === undefined) return false;
  const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
  return (rank[have] ?? 0) >= rank[min]!;
}

function isOrgAdminOrScanAdmin(
  user: NonNullable<Express.Request['user']>,
): boolean {
  return user.isOrgAdmin || user.roles.scan === 'admin';
}

async function fetchOwnedJob(
  store: ScanJobStore,
  id: string,
  user: NonNullable<Express.Request['user']>,
): Promise<ScanJobRecord> {
  let job: ScanJobRecord | null;
  try {
    job = await store.findById(id);
  } catch (err) {
    if (err instanceof ScanJobNotFoundError) {
      throw new NotFoundError('scan job');
    }
    throw err;
  }
  if (job === null) {
    throw new NotFoundError('scan job');
  }
  if (!isOrgAdminOrScanAdmin(user) && job.userId !== user.id) {
    throw new NotFoundError('scan job');
  }
  return job;
}

const FILENAME_SANITIZE = /[^A-Za-z0-9._-]/g;
function sanitizeFilename(name: string): string {
  const trimmed = (name || 'upload').slice(-200).replace(FILENAME_SANITIZE, '_');
  return trimmed.length > 0 ? trimmed : 'upload';
}
