/**
 * Redact pipeline — Phase D + Phase 17 v1.4.
 *
 * Synchronous (no queue, no SSE) end-to-end:
 *   1. Caller hands us the source bytes + a freshly-created
 *      ``vs_redact_jobs`` row in pending state.
 *   2. We mark the job ``running``, set ``pages_count``, write
 *      ``source.<ext>``, emit an ``audit.jsonl`` line.
 *   3. Call engine ``/redact-image`` to get back the masked PNG +
 *      OCR text + per-region bbox metadata.
 *   4. Write ``redacted.pdf``, ``extracted.md``, ``extracted.json``.
 *      v1.4 ships image-only: redacted.pdf is actually a PDF wrap of
 *      the single masked PNG, produced via pdf-lib so the operator
 *      gets a uniform .pdf download regardless of source format.
 *   5. Mark the job ``completed`` (or ``failed`` on any exception).
 *   6. Best-effort vs_audit append with module='redact'.
 *
 * v1.5 adds: multi-page PDF input + per-page progress + SSE stream.
 */

import { PDFDocument } from 'pdf-lib';
import type { Logger } from 'pino';
import {
  type AuditLogger,
  type RedactJobRecord,
  type RedactJobStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type { EngineClient, RedactImageResponse } from '../engine/client.js';
import { JobStorage } from './storage.js';

export interface RedactPipelineDeps {
  jobs: RedactJobStore;
  engine: EngineClient;
  storage: JobStorage;
  audit?: AuditLogger;
  logger: Logger;
}

export class RedactPipeline {
  constructor(private readonly deps: RedactPipelineDeps) {}

  /**
   * Run the full pipeline for a job that was just created. Returns
   * the updated record (status=completed or failed). Never throws —
   * the failure is captured into the row + audit log.
   */
  async run(
    job: RedactJobRecord,
    sourceBytes: Buffer,
    sourceExt: string,
    correlationId?: string,
  ): Promise<RedactJobRecord> {
    const started = Date.now();
    try {
      await this.deps.jobs.markRunning(job.id, /* pagesCount */ 1);
      const { path: sourcePath, size } = await this.deps.storage.writeSource(
        job.id,
        sourceExt,
        sourceBytes,
      );
      await this.deps.storage.appendAudit(job.id, {
        event: 'source_written',
        path: sourcePath,
        size,
        ts: new Date().toISOString(),
      });

      // Call engine. v1.4 image-only: pass the source bytes directly.
      const engineResp = await this.deps.engine.redactImage(
        sourceBytes,
        correlationId,
      );

      // Persist artifacts.
      const maskedPng = Buffer.from(engineResp.masked_image_base64, 'base64');
      await this.deps.storage.writePage(job.id, 1, maskedPng);
      const redactedPdf = await imageToSinglePagePdf(maskedPng);
      await this.deps.storage.writeArtifact(job.id, 'redacted', redactedPdf);
      await this.deps.storage.writeArtifact(
        job.id,
        'extracted_md',
        buildMarkdown(job, engineResp),
      );
      await this.deps.storage.writeArtifact(
        job.id,
        'extracted_json',
        JSON.stringify(
          {
            job_id: job.id,
            filename: job.filename,
            mime: job.mime,
            redacted_text: engineResp.redacted_text,
            tokens: engineResp.tokens.map((t) => ({
              token: t.token,
              entity_type: t.entity_type,
            })),
            masked_regions: engineResp.masked_regions,
            image_sha256: engineResp.image_sha256,
            masked_image_sha256: engineResp.masked_image_sha256,
          },
          null,
          2,
        ),
      );

      await this.deps.storage.appendAudit(job.id, {
        event: 'redaction_complete',
        masked_image_sha256: engineResp.masked_image_sha256,
        tokens_count: engineResp.tokens.length,
        regions_count: engineResp.masked_regions.length,
        elapsed_ms: Date.now() - started,
        ts: new Date().toISOString(),
      });

      await this.deps.jobs.markCompleted(job.id);

      // Best-effort vs_audit emission for the appliance-wide audit log.
      if (this.deps.audit !== undefined) {
        void this.deps.audit
          .append({
            tenantId: 'appliance',
            eventType: 'request',
            module: 'redact',
            payload: {
              action: 'redact_completed',
              job_id: job.id,
              user_id: job.userId,
              mime: job.mime,
              source_size_bytes: job.sourceSizeBytes,
              tokens_count: engineResp.tokens.length,
              regions_count: engineResp.masked_regions.length,
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
        'redact pipeline failed',
      );
      await this.deps.jobs.markFailed(job.id, reason).catch(() => undefined);
      await this.deps.storage
        .appendAudit(job.id, {
          event: 'redaction_failed',
          reason,
          ts: new Date().toISOString(),
        })
        .catch(() => undefined);
      if (this.deps.audit !== undefined) {
        void this.deps.audit
          .append({
            tenantId: 'appliance',
            eventType: 'request',
            module: 'redact',
            payload: {
              action: 'redact_failed',
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
}

/** Wrap a single masked PNG into a one-page PDF via pdf-lib. */
async function imageToSinglePagePdf(png: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  doc.setTitle('Vibe Shield — redacted');
  doc.setProducer('Vibe Shield v1.4');
  doc.setCreator('Vibe Shield');
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function buildMarkdown(
  job: RedactJobRecord,
  engine: RedactImageResponse,
): string {
  const lines: string[] = [];
  lines.push(`# Redacted: ${job.filename}`);
  lines.push('');
  lines.push(`- Job ID: \`${job.id}\``);
  lines.push(`- Source MIME: ${job.mime}`);
  lines.push(`- Source SHA-256: \`${engine.image_sha256}\``);
  lines.push(`- Redacted SHA-256: \`${engine.masked_image_sha256}\``);
  lines.push(`- Regions masked: ${engine.masked_regions.length.toString()}`);
  lines.push(`- Tokens substituted: ${engine.tokens.length.toString()}`);
  lines.push('');
  lines.push('## Extracted text (post-redaction)');
  lines.push('');
  lines.push('```');
  lines.push(engine.redacted_text);
  lines.push('```');
  if (engine.tokens.length > 0) {
    lines.push('');
    lines.push('## Token map');
    lines.push('');
    lines.push('| Token | Entity type |');
    lines.push('|-------|-------------|');
    for (const t of engine.tokens) {
      lines.push(`| \`${t.token}\` | ${t.entity_type} |`);
    }
  }
  return lines.join('\n') + '\n';
}
