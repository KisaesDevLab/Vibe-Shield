/**
 * Artifact-purge cron — v1.5.
 *
 * Walks ``vs_redact_jobs.findExpired()`` on an interval and removes:
 *   1. The on-disk directory ``<REDACT_JOBS_DIR>/<job_id>/`` recursively.
 *   2. The DB row.
 *
 * Best-effort: any per-job failure logs a warn and the loop moves on
 * (the next interval will retry). A whole-batch failure (DB outage)
 * logs once and skips this tick.
 *
 * Default interval: 1 hour. Configurable via
 * ``REDACT_PURGE_INTERVAL_MS``. Set to 0 to disable (tests + dev).
 *
 * Only ``completed`` jobs are reaped. ``failed`` jobs stick around so
 * the operator can diagnose what went wrong; an explicit DELETE via
 * the admin SPA is how those go away.
 */

import type { Logger } from 'pino';
import {
  type AuditLogger,
  type RedactJobStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type { JobStorage } from './storage.js';

export interface PurgeCronDeps {
  jobs: RedactJobStore;
  storage: JobStorage;
  audit?: AuditLogger;
  logger: Logger;
  /** Tick interval ms. <=0 disables. Default 1 hour. */
  intervalMs?: number;
}

export class RedactPurgeCron {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly deps: PurgeCronDeps;
  private readonly intervalMs: number;

  constructor(deps: PurgeCronDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  }

  start(): void {
    if (this.intervalMs <= 0 || this.timer !== undefined) return;
    // Fire on a small initial delay so we don't pile up at boot.
    const initial = setTimeout(() => {
      void this.runOnce();
    }, Math.min(this.intervalMs, 30_000));
    initial.unref?.();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One purge pass. Returns the number of jobs successfully cleaned.
   * Public so a test can drive it deterministically.
   */
  async runOnce(): Promise<number> {
    let expired;
    try {
      expired = await this.deps.jobs.findExpired();
    } catch (err) {
      this.deps.logger.warn(
        { error_class: err instanceof Error ? err.name : 'Unknown' },
        'redact purge: findExpired failed',
      );
      return 0;
    }
    if (expired.length === 0) return 0;

    let cleaned = 0;
    for (const job of expired) {
      try {
        await this.deps.storage.purgeJob(job.id);
        await this.deps.jobs.delete(job.id);
        cleaned += 1;
        if (this.deps.audit !== undefined) {
          void this.deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'session_purge',
              module: 'redact',
              actorType: 'system',
              payload: {
                action: 'redact_artifact_purged',
                job_id: job.id,
                user_id: job.userId,
                age_days: Math.floor(
                  (Date.now() - job.createdAt.getTime()) / 86_400_000,
                ),
              },
            })
            .catch(() => undefined);
        }
      } catch (err) {
        this.deps.logger.warn(
          {
            job_id: job.id,
            error_class: err instanceof Error ? err.name : 'Unknown',
          },
          'redact purge: per-job cleanup failed',
        );
      }
    }
    if (cleaned > 0) {
      this.deps.logger.info({ cleaned }, 'redact purge cron tick');
    }
    return cleaned;
  }
}
