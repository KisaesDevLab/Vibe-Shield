/**
 * Scheduled-scan runner — Phase 26 v1.9.
 *
 * Polls the ``vs_scheduled_scans`` table every minute; for each row
 * whose ``next_run_at`` has elapsed:
 *   1. Walk the source ref (filesystem path) to enumerate scan inputs.
 *   2. For each input file, run the ScanPipeline.
 *   3. Update ``last_run_*`` and recompute ``next_run_at`` from cron.
 *   4. Hand the resulting job to the alerter for SMTP/webhook delivery.
 *
 * v1.9 supports ``source_kind = 'filesystem'`` only; the source_ref
 * must live under ``SCHEDULED_SCAN_ROOT`` for path-traversal safety.
 *
 * The scheduler runs in-process. A multi-process / multi-host
 * deployment would need a distributed lock (Redis SETNX) here — out
 * of scope for v1.9 since Vibe Shield ships single-process.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type {
  ScanJobStore,
  ScheduledScanRecord,
  ScheduledScanStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type { ScanPipeline } from './pipeline.js';
import type { ScheduledScanAlerter } from './alerter.js';
import { nextRun } from './cron.js';

export interface SchedulerDeps {
  scheduledScans: ScheduledScanStore;
  scanJobs: ScanJobStore;
  pipeline: ScanPipeline;
  alerter: ScheduledScanAlerter;
  logger: Logger;
  /** Root directory the filesystem source_ref must live under. The
   *  appliance volume; the scheduler refuses any path outside it. */
  scanRoot: string;
  /** Poll interval. Default 60 s. Tests pass 0 to disable the timer
   *  and call ``runOnce()`` directly. */
  intervalMs?: number;
}

const ALLOWED_EXTS = new Set([
  '.txt',
  '.md',
  '.log',
  '.csv',
  '.json',
  '.pdf',
  '.xlsx',
  '.zip',
  '.eml',
  '.mbox',
]);

const MAX_FILES_PER_RUN = 200;
const MAX_DEPTH = 5;

export class ScheduledScanRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.deps.intervalMs ?? 60_000;
    if (intervalMs === 0) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.deps.logger.error(
          { error_class: err instanceof Error ? err.name : 'Unknown' },
          'scheduled scan tick failed',
        );
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Walk every scheduled scan whose ``next_run_at`` has elapsed.
   * Returns the number of rows it fired. Public so tests can drive
   * the loop synchronously.
   */
  async runOnce(now: Date = new Date()): Promise<number> {
    const due = await this.deps.scheduledScans.listDue(now);
    for (const row of due) {
      await this.run(row, now).catch((err: unknown) => {
        this.deps.logger.error(
          {
            scheduled_scan_id: row.id,
            error_class: err instanceof Error ? err.name : 'Unknown',
          },
          'scheduled scan run failed',
        );
      });
    }
    return due.length;
  }

  async run(row: ScheduledScanRecord, runAt: Date): Promise<void> {
    if (row.sourceKind !== 'filesystem') {
      // v1.9 only supports filesystem sources; mark next-run anyway
      // so the row doesn't busy-loop.
      const next = computeNext(row.cronExpression, runAt);
      await this.deps.scheduledScans.markRun(row.id, null, next, runAt);
      return;
    }

    const targetPath = resolveSafePath(this.deps.scanRoot, row.sourceRef);
    if (targetPath === null) {
      this.deps.logger.warn(
        { scheduled_scan_id: row.id, source_ref: row.sourceRef },
        'scheduled scan source_ref escaped scan root; skipping',
      );
      const next = computeNext(row.cronExpression, runAt);
      await this.deps.scheduledScans.markRun(row.id, null, next, runAt);
      return;
    }

    const files = await this.enumerate(targetPath);
    if (files.length === 0) {
      this.deps.logger.info(
        { scheduled_scan_id: row.id, path: targetPath },
        'scheduled scan found no eligible files',
      );
      const next = computeNext(row.cronExpression, runAt);
      await this.deps.scheduledScans.markRun(row.id, null, next, runAt);
      return;
    }

    // v1.9: one ScanJob per scheduled run. We pipe each enumerated
    // file as its own input through the pipeline by reading bytes
    // and calling the engine through the pipeline-internal path.
    // For simplicity we treat the first file as the "source" of the
    // job; subsequent files are processed via the same pipeline by
    // looping. A future v1.10 will gather them into a single
    // archive upload for atomicity.
    const lastJobIds: string[] = [];
    for (const filePath of files.slice(0, MAX_FILES_PER_RUN)) {
      try {
        const bytes = await readFile(filePath);
        const relative = filePath.slice(this.deps.scanRoot.length + 1) || filePath;
        const mime = mimeFromExt(extname(filePath));
        const job = await this.deps.scanJobs.create({
          userId: row.userId,
          sourceKind: 'file',
          sourceName: relative,
          sourceMime: mime,
          sourceSizeBytes: bytes.length,
        });
        const finished = await this.deps.pipeline.run(
          job,
          bytes,
          `scheduled:${row.id}`,
        );
        lastJobIds.push(finished.id);
        await this.deps.alerter.maybeAlert(row, finished);
      } catch (err) {
        this.deps.logger.error(
          {
            scheduled_scan_id: row.id,
            file_path: filePath,
            error_class: err instanceof Error ? err.name : 'Unknown',
          },
          'scheduled scan: file pipeline failed',
        );
      }
    }
    const next = computeNext(row.cronExpression, runAt);
    await this.deps.scheduledScans.markRun(
      row.id,
      lastJobIds.length === 0 ? null : lastJobIds[lastJobIds.length - 1] ?? null,
      next,
      runAt,
    );
  }

  /**
   * Walk a directory recursively up to MAX_DEPTH; return up to
   * MAX_FILES_PER_RUN paths of supported extensions. A single file
   * path returns just that path.
   */
  private async enumerate(root: string): Promise<string[]> {
    const statRoot = await stat(root).catch(() => null);
    if (statRoot === null) return [];
    if (statRoot.isFile()) return [root];
    if (!statRoot.isDirectory()) return [];
    const out: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      if (out.length >= MAX_FILES_PER_RUN) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => null,
      );
      if (entries === null) return;
      for (const e of entries) {
        if (out.length >= MAX_FILES_PER_RUN) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p, depth + 1);
        } else if (e.isFile()) {
          const ext = extname(e.name).toLowerCase();
          if (ALLOWED_EXTS.has(ext)) {
            out.push(p);
          }
        }
      }
    };

    await walk(root, 0);
    return out;
  }
}

function resolveSafePath(scanRoot: string, ref: string): string | null {
  const root = resolve(scanRoot);
  const target = resolve(scanRoot, ref);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

function computeNext(cronExpr: string, from: Date): Date | null {
  try {
    return nextRun(cronExpr, from);
  } catch {
    return null;
  }
}

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.txt' || e === '.md' || e === '.log') return 'text/plain';
  if (e === '.csv') return 'text/csv';
  if (e === '.pdf') return 'application/pdf';
  if (e === '.xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (e === '.zip') return 'application/zip';
  if (e === '.json') return 'application/json';
  if (e === '.eml') return 'message/rfc822';
  if (e === '.mbox') return 'application/mbox';
  return 'application/octet-stream';
}
