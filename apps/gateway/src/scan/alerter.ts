/**
 * Scheduled-scan alerter — Phase 26 v1.9.
 *
 * After a scheduled run finishes, the scheduler hands the row +
 * the resulting job to this alerter. The alerter decides whether
 * to fire (severity threshold) and dispatches to the configured
 * channels: SMTP (via the existing Mailer abstraction) and/or
 * webhook (POST JSON with an HMAC-SHA256 signature header).
 */

import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  ScanJobRecord,
  ScheduledScanRecord,
} from '@kisaesdevlab/vibe-shield-schema';
import type { Mailer } from '../auth/mailer.js';

export interface AlerterDeps {
  mailer?: Mailer;
  fetchImpl?: typeof fetch;
  logger: Logger;
  /** Public URL used in email links. Optional — emails omit a link
   *  when unset. */
  publicUrl?: string;
}

export class ScheduledScanAlerter {
  constructor(private readonly deps: AlerterDeps) {}

  /**
   * Fire alerts iff the new run produced at least one finding at or
   * above the row's ``alert_min_severity``. Best-effort: a failed
   * delivery is logged but never thrown.
   */
  async maybeAlert(
    row: ScheduledScanRecord,
    job: ScanJobRecord,
  ): Promise<void> {
    const trigger = matchesThreshold(row.alertMinSeverity, job);
    if (!trigger) return;
    await Promise.all([
      this.tryEmail(row, job),
      this.tryWebhook(row, job),
    ]);
  }

  private async tryEmail(
    row: ScheduledScanRecord,
    job: ScanJobRecord,
  ): Promise<void> {
    if (row.notifyEmails === null || row.notifyEmails.trim() === '') return;
    if (this.deps.mailer === undefined) {
      this.deps.logger.warn(
        { scheduled_scan_id: row.id },
        'scheduled-scan alert: SMTP not configured, skipping email',
      );
      return;
    }
    const recipients = row.notifyEmails
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (recipients.length === 0) return;
    const subject = `[Vibe Shield] ${row.name}: ${job.findingsHigh.toString()} high, ${job.findingsMedium.toString()} medium`;
    const link =
      this.deps.publicUrl !== undefined
        ? `${this.deps.publicUrl.replace(/\/$/, '')}/scan/${job.id}`
        : null;
    const body = [
      `Scheduled scan "${row.name}" produced new findings.`,
      ``,
      `Source: ${row.sourceKind}:${row.sourceRef}`,
      `Files scanned:  ${job.filesCount.toString()}`,
      `Findings total: ${job.findingsCount.toString()}`,
      `  high   ${job.findingsHigh.toString()}`,
      `  medium ${job.findingsMedium.toString()}`,
      `  low    ${job.findingsLow.toString()}`,
      ``,
      link !== null ? `Open the run: ${link}` : '',
      ``,
      `Alert threshold: ${row.alertMinSeverity} and above.`,
      `This is an automated message from your Vibe Shield appliance.`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    for (const to of recipients) {
      try {
        await this.deps.mailer.send({
          to,
          subject,
          text: body,
        });
      } catch (err) {
        this.deps.logger.error(
          {
            scheduled_scan_id: row.id,
            error_class: err instanceof Error ? err.name : 'Unknown',
          },
          'scheduled-scan email failed',
        );
      }
    }
  }

  private async tryWebhook(
    row: ScheduledScanRecord,
    job: ScanJobRecord,
  ): Promise<void> {
    if (
      row.webhookUrl === null ||
      row.webhookUrl.trim() === '' ||
      row.webhookSecret === null ||
      row.webhookSecret.trim() === ''
    ) {
      return;
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const payload = JSON.stringify({
      event: 'scheduled_scan.completed',
      scheduled_scan: {
        id: row.id,
        name: row.name,
        source_kind: row.sourceKind,
        source_ref: row.sourceRef,
        alert_min_severity: row.alertMinSeverity,
      },
      run: {
        job_id: job.id,
        source_name: job.sourceName,
        files_count: job.filesCount,
        findings_count: job.findingsCount,
        findings_high: job.findingsHigh,
        findings_medium: job.findingsMedium,
        findings_low: job.findingsLow,
        started_at: job.startedAt?.toISOString() ?? null,
        finished_at: job.finishedAt?.toISOString() ?? null,
      },
    });
    const sig = createHmac('sha256', row.webhookSecret)
      .update(payload)
      .digest('hex');
    try {
      const res = await fetchImpl(row.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vibe-shield-signature': `sha256=${sig}`,
          'x-vibe-shield-event': 'scheduled_scan.completed',
        },
        body: payload,
      });
      if (!res.ok) {
        this.deps.logger.warn(
          {
            scheduled_scan_id: row.id,
            status: res.status,
          },
          'scheduled-scan webhook returned non-2xx',
        );
      }
    } catch (err) {
      this.deps.logger.error(
        {
          scheduled_scan_id: row.id,
          error_class: err instanceof Error ? err.name : 'Unknown',
        },
        'scheduled-scan webhook delivery failed',
      );
    }
  }
}

function matchesThreshold(
  threshold: 'low' | 'medium' | 'high',
  job: ScanJobRecord,
): boolean {
  if (threshold === 'high') return job.findingsHigh > 0;
  if (threshold === 'medium') {
    return job.findingsHigh > 0 || job.findingsMedium > 0;
  }
  return job.findingsCount > 0;
}
