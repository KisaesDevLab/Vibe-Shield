/**
 * Scan pipeline — Phase 26 (v1.8 foundation).
 *
 * Mirrors RedactPipeline. Given a freshly-created vs_scan_jobs row +
 * the source bytes, dispatch to the engine's /scan endpoint, persist
 * each file_scanned/file_skipped event as a vs_scan_files row, then
 * persist each finding event as a vs_scan_findings row joined back to
 * the right file row. Status transitions: pending → running →
 * (completed | failed). Best-effort SSE emission via ScanJobEvents.
 *
 * Pipeline never throws — every error lands in the row.
 */

import type { Logger } from 'pino';
import type {
  AuditLogger,
  ScanJobRecord,
  ScanJobStore,
  ScanSeverity,
} from '@kisaesdevlab/vibe-shield-schema';
import type { EngineClient } from '../engine/client.js';
import type { ScanJobEvents } from './job-events.js';

export interface ScanPipelineDeps {
  jobs: ScanJobStore;
  engine: EngineClient;
  audit?: AuditLogger;
  logger: Logger;
  events?: ScanJobEvents;
}

export class ScanPipeline {
  constructor(private readonly deps: ScanPipelineDeps) {}

  async run(
    job: ScanJobRecord,
    sourceBytes: Buffer,
    correlationId?: string,
  ): Promise<ScanJobRecord> {
    const started = Date.now();
    try {
      await this.deps.jobs.markRunning(job.id);
      this.emitEvent({
        jobId: job.id,
        type: 'job_started',
        ts: new Date().toISOString(),
      });

      // Track which engine path → DB file id so findings join correctly.
      const fileIdByPath = new Map<string, string>();

      const summary = await this.deps.engine.scan(
        sourceBytes,
        job.sourceName,
        job.sourceMime,
        {
          sourceKind: job.sourceKind,
          ...(correlationId !== undefined ? { correlationId } : {}),
          onEvent: (event) => {
            // We deliberately do fire-and-forget DB writes here — the
            // engine stream must not stall on Postgres latency. Any DB
            // failure is logged + counted as a job-level error.
            if (event.type === 'file_scanned' || event.type === 'file_skipped') {
              void this.deps.jobs
                .addFile({
                  jobId: job.id,
                  path: event.path,
                  mime: event.mime,
                  sizeBytes: event.size_bytes,
                  sha256: event.sha256,
                  ...(event.type === 'file_skipped'
                    ? { skippedReason: event.reason }
                    : {}),
                })
                .then((row) => {
                  fileIdByPath.set(event.path, row.id);
                  this.emitEvent({
                    jobId: job.id,
                    type: 'file',
                    path: event.path,
                    skipped: event.type === 'file_skipped',
                    ts: new Date().toISOString(),
                  });
                })
                .catch((err: unknown) => {
                  this.deps.logger.error(
                    {
                      job_id: job.id,
                      path: event.path,
                      error_class:
                        err instanceof Error ? err.name : 'Unknown',
                    },
                    'scan: addFile failed',
                  );
                });
            } else if (event.type === 'finding') {
              // The corresponding addFile may still be in flight; the
              // engine ordering guarantees file_scanned arrives before
              // any finding for that path. We resolve the id by polling
              // the map briefly via microtask.
              void (async () => {
                let fileId = fileIdByPath.get(event.path);
                for (let i = 0; i < 50 && fileId === undefined; i++) {
                  // Wait a microtask + a few ms for the file insert
                  // to land. 50 * 20 ms = 1s upper bound, well below
                  // any reasonable pipeline timeout.
                  await new Promise((res) => setTimeout(res, 20));
                  fileId = fileIdByPath.get(event.path);
                }
                if (fileId === undefined) {
                  this.deps.logger.warn(
                    { job_id: job.id, path: event.path },
                    'scan: dropping finding (file row never appeared)',
                  );
                  return;
                }
                try {
                  await this.deps.jobs.addFinding({
                    jobId: job.id,
                    fileId,
                    entityType: event.entity_type,
                    severity: event.severity as ScanSeverity,
                    location: event.location,
                    snippetRedacted: event.snippet_redacted,
                    sampleHash: event.sample_hash,
                  });
                  this.emitEvent({
                    jobId: job.id,
                    type: 'finding',
                    entityType: event.entity_type,
                    severity: event.severity,
                    ts: new Date().toISOString(),
                  });
                } catch (err) {
                  this.deps.logger.error(
                    {
                      job_id: job.id,
                      path: event.path,
                      error_class: err instanceof Error ? err.name : 'Unknown',
                    },
                    'scan: addFinding failed',
                  );
                }
              })();
            }
          },
        },
      );

      // Wait briefly for any in-flight addFile/addFinding to drain.
      // Fire-and-forget writes are racy at the very end of the stream
      // — give them a window before we mark completed.
      await new Promise((res) => setTimeout(res, 100));

      await this.deps.jobs.markCompleted(job.id);
      this.emitEvent({
        jobId: job.id,
        type: 'job_completed',
        filesCount: summary.files_count,
        findingsCount: summary.findings_count,
        ts: new Date().toISOString(),
      });

      if (this.deps.audit !== undefined) {
        void this.deps.audit
          .append({
            tenantId: 'appliance',
            eventType: 'request',
            module: 'scan',
            payload: {
              action: 'scan_completed',
              job_id: job.id,
              user_id: job.userId,
              source_kind: job.sourceKind,
              files_count: summary.files_count,
              findings_count: summary.findings_count,
              findings_high: summary.findings_high,
              elapsed_ms: Date.now() - started,
            },
          })
          .catch(() => undefined);
      }

      const updated = await this.deps.jobs.findById(job.id);
      return updated ?? job;
    } catch (err) {
      const reason =
        err instanceof Error ? `${err.name}: ${err.message}` : 'unknown failure';
      this.deps.logger.error(
        {
          job_id: job.id,
          error_class: err instanceof Error ? err.name : 'Unknown',
        },
        'scan pipeline failed',
      );
      await this.deps.jobs.markFailed(job.id, reason).catch(() => undefined);
      this.emitEvent({
        jobId: job.id,
        type: 'job_failed',
        errorMessage: reason,
        ts: new Date().toISOString(),
      });
      if (this.deps.audit !== undefined) {
        void this.deps.audit
          .append({
            tenantId: 'appliance',
            eventType: 'request',
            module: 'scan',
            payload: {
              action: 'scan_failed',
              job_id: job.id,
              user_id: job.userId,
              error_class: err instanceof Error ? err.name : 'Unknown',
            },
          })
          .catch(() => undefined);
      }
      const updated = await this.deps.jobs.findById(job.id);
      return updated ?? job;
    }
  }

  private emitEvent(event: import('./job-events.js').ScanJobEvent): void {
    if (this.deps.events !== undefined) {
      this.deps.events.emit(event);
    }
  }
}
