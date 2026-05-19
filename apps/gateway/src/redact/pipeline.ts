/**
 * Redact pipeline — Phase D + Phase 17.
 *
 * v1.4 (image-only) → v1.5 adds PDF.
 *
 * Per-job state machine:
 *   1. Caller hands us the source bytes + a freshly-created
 *      ``vs_redact_jobs`` row in ``pending``.
 *   2. We mark ``running``, set ``pages_count``, write ``source.<ext>``.
 *   3. Branch on MIME:
 *        - image/* → engine ``/redact-image`` (single call)
 *        - application/pdf → engine ``/redact-pdf`` (rasterize +
 *          per-page redaction); per-page progress events emitted to
 *          ``RedactJobEvents`` for SSE subscribers.
 *   4. Write ``redacted.pdf`` (single image wrap OR multi-page
 *      reassembly), ``extracted.md``, ``extracted.json``, per-page
 *      PNGs under ``pages/``.
 *   5. Mark ``completed`` (or ``failed`` on any exception).
 *   6. Best-effort ``vs_audit`` append with ``module='redact'``.
 *
 * The pipeline never throws — every error is captured into the row.
 */

import { PDFDocument } from 'pdf-lib';
import type { Logger } from 'pino';
import {
  type AuditLogger,
  type RedactJobRecord,
  type RedactJobStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type {
  EngineClient,
  EngineMaskedRegion,
  EngineTokenEntry,
  RedactImageResponse,
  RedactPdfResponse,
} from '../engine/client.js';
import { RedactJobEvents } from './job-events.js';
import { JobStorage } from './storage.js';

export interface RedactPipelineDeps {
  jobs: RedactJobStore;
  engine: EngineClient;
  storage: JobStorage;
  audit?: AuditLogger;
  logger: Logger;
  /** v1.5 — event broker for SSE progress. Optional in tests. */
  events?: RedactJobEvents;
}

export class RedactPipeline {
  constructor(private readonly deps: RedactPipelineDeps) {}

  /**
   * Run the full pipeline for a job that was just created. Never
   * throws — failures land in the row + audit log.
   */
  async run(
    job: RedactJobRecord,
    sourceBytes: Buffer,
    sourceExt: string,
    correlationId?: string,
  ): Promise<RedactJobRecord> {
    const started = Date.now();
    try {
      const isPdf = job.mime === 'application/pdf';
      // For images we know it's 1 page; for PDFs the count is set
      // after the engine response.
      await this.deps.jobs.markRunning(job.id, isPdf ? 0 : 1);
      const { path: sourcePath, size } = await this.deps.storage.writeSource(
        job.id,
        sourceExt,
        sourceBytes,
      );
      await this.deps.storage.appendAudit(job.id, {
        event: 'source_written',
        path: sourcePath,
        size,
        mime: job.mime,
        ts: new Date().toISOString(),
      });

      if (isPdf) {
        await this.runPdf(job, sourceBytes, correlationId, started);
      } else {
        await this.runImage(job, sourceBytes, correlationId, started);
      }

      await this.deps.jobs.markCompleted(job.id);
      this.emitEvent({ jobId: job.id, type: 'job_completed', ts: new Date().toISOString() });

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

  /** Single-image path (PNG/JPEG/WebP/TIFF/BMP). */
  private async runImage(
    job: RedactJobRecord,
    sourceBytes: Buffer,
    correlationId: string | undefined,
    started: number,
  ): Promise<void> {
    this.emitEvent({
      jobId: job.id,
      type: 'page_started',
      page: 1,
      totalPages: 1,
      ts: new Date().toISOString(),
    });
    const engineResp = await this.deps.engine.redactImage(sourceBytes, correlationId);

    const maskedPng = Buffer.from(engineResp.masked_image_base64, 'base64');
    await this.deps.storage.writePage(job.id, 1, maskedPng);
    const redactedPdf = await imagesToPdf([maskedPng]);
    await this.deps.storage.writeArtifact(job.id, 'redacted', redactedPdf);
    await this.deps.storage.writeArtifact(
      job.id,
      'extracted_md',
      buildImageMarkdown(job, engineResp),
    );
    await this.deps.storage.writeArtifact(
      job.id,
      'extracted_json',
      JSON.stringify(
        {
          job_id: job.id,
          filename: job.filename,
          mime: job.mime,
          pages: [
            {
              page_number: 1,
              redacted_text: engineResp.redacted_text,
              tokens: engineResp.tokens.map((t) => ({
                token: t.token,
                entity_type: t.entity_type,
              })),
              masked_regions: engineResp.masked_regions,
            },
          ],
          image_sha256: engineResp.image_sha256,
          masked_image_sha256: engineResp.masked_image_sha256,
        },
        null,
        2,
      ),
    );

    this.emitEvent({
      jobId: job.id,
      type: 'page_completed',
      page: 1,
      totalPages: 1,
      tokensCount: engineResp.tokens.length,
      ts: new Date().toISOString(),
    });
    await this.deps.storage.appendAudit(job.id, {
      event: 'redaction_complete',
      masked_image_sha256: engineResp.masked_image_sha256,
      tokens_count: engineResp.tokens.length,
      regions_count: engineResp.masked_regions.length,
      elapsed_ms: Date.now() - started,
      ts: new Date().toISOString(),
    });

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
            pages_count: 1,
            tokens_count: engineResp.tokens.length,
            regions_count: engineResp.masked_regions.length,
          },
        })
        .catch(() => undefined);
    }
  }

  /** v1.5 — multi-page PDF path. */
  private async runPdf(
    job: RedactJobRecord,
    sourceBytes: Buffer,
    correlationId: string | undefined,
    started: number,
  ): Promise<void> {
    // The engine does the whole PDF in one call. We emit a single
    // page_started+page_completed pair around the engine call to
    // show *something* to the SPA; per-page granularity would
    // require a streaming engine response which is v1.6 scope.
    this.emitEvent({
      jobId: job.id,
      type: 'page_started',
      page: 1,
      ts: new Date().toISOString(),
    });
    const engineResp: RedactPdfResponse = await this.deps.engine.redactPdf(sourceBytes, {
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
    // Now we know the page count — update the row.
    await this.deps.jobs.markRunning(job.id, engineResp.pages_count);

    // Write per-page PNGs + accumulate the assembled PDF.
    const pngBuffers: Buffer[] = [];
    for (const page of engineResp.pages) {
      const png = Buffer.from(page.masked_image_base64, 'base64');
      pngBuffers.push(png);
      await this.deps.storage.writePage(job.id, page.page_number, png);
      this.emitEvent({
        jobId: job.id,
        type: 'page_completed',
        page: page.page_number,
        totalPages: engineResp.pages_count,
        tokensCount: page.tokens.length,
        ts: new Date().toISOString(),
      });
      await this.deps.storage.appendAudit(job.id, {
        event: 'page_complete',
        page_number: page.page_number,
        masked_image_sha256: page.masked_image_sha256,
        tokens_count: page.tokens.length,
        regions_count: page.masked_regions.length,
        ts: new Date().toISOString(),
      });
    }

    const redactedPdf = await imagesToPdf(pngBuffers);
    await this.deps.storage.writeArtifact(job.id, 'redacted', redactedPdf);
    await this.deps.storage.writeArtifact(
      job.id,
      'extracted_md',
      buildPdfMarkdown(job, engineResp),
    );
    await this.deps.storage.writeArtifact(
      job.id,
      'extracted_json',
      JSON.stringify(
        {
          job_id: job.id,
          filename: job.filename,
          mime: job.mime,
          pdf_sha256: engineResp.pdf_sha256,
          pages_count: engineResp.pages_count,
          pages: engineResp.pages.map((p) => ({
            page_number: p.page_number,
            redacted_text: p.redacted_text,
            tokens: p.tokens.map((t) => ({
              token: t.token,
              entity_type: t.entity_type,
            })),
            masked_regions: p.masked_regions,
            masked_image_sha256: p.masked_image_sha256,
          })),
        },
        null,
        2,
      ),
    );

    const totalTokens = engineResp.tokens_concatenated.length;
    const totalRegions = engineResp.pages.reduce(
      (sum, p) => sum + p.masked_regions.length,
      0,
    );
    await this.deps.storage.appendAudit(job.id, {
      event: 'redaction_complete',
      pdf_sha256: engineResp.pdf_sha256,
      pages_count: engineResp.pages_count,
      tokens_count: totalTokens,
      regions_count: totalRegions,
      elapsed_ms: Date.now() - started,
      ts: new Date().toISOString(),
    });

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
            pages_count: engineResp.pages_count,
            tokens_count: totalTokens,
            regions_count: totalRegions,
          },
        })
        .catch(() => undefined);
    }
  }

  private emitEvent(
    event: import('./job-events.js').RedactJobEvent,
  ): void {
    if (this.deps.events !== undefined) {
      this.deps.events.emit(event);
    }
  }
}

/**
 * Assemble PNGs into a single PDF, one page each. Pages adopt the
 * dimensions of the source PNG (we get back the engine's rasterized
 * size, so the PDF preserves the visual layout 1:1).
 */
async function imagesToPdf(pngs: Buffer[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const png of pngs) {
    const img = await doc.embedPng(png);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  doc.setTitle('Vibe Shield — redacted');
  doc.setProducer('Vibe Shield v1.5');
  doc.setCreator('Vibe Shield');
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function buildImageMarkdown(
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

function buildPdfMarkdown(
  job: RedactJobRecord,
  engine: RedactPdfResponse,
): string {
  const lines: string[] = [];
  lines.push(`# Redacted: ${job.filename}`);
  lines.push('');
  lines.push(`- Job ID: \`${job.id}\``);
  lines.push(`- Source MIME: ${job.mime}`);
  lines.push(`- PDF SHA-256: \`${engine.pdf_sha256}\``);
  lines.push(`- Pages: ${engine.pages_count.toString()}`);
  const tokenSum = engine.tokens_concatenated.length;
  const regionSum = engine.pages.reduce(
    (s, p) => s + p.masked_regions.length,
    0,
  );
  lines.push(`- Total regions masked: ${regionSum.toString()}`);
  lines.push(`- Total tokens substituted: ${tokenSum.toString()}`);
  lines.push('');
  for (const page of engine.pages) {
    lines.push(`## Page ${page.page_number.toString()}`);
    lines.push('');
    lines.push('```');
    lines.push(page.redacted_text);
    lines.push('```');
    if (page.tokens.length > 0) {
      lines.push('');
      lines.push('| Token | Entity type |');
      lines.push('|-------|-------------|');
      for (const t of page.tokens) {
        lines.push(`| \`${t.token}\` | ${t.entity_type} |`);
      }
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// Avoid unused-import warning when the type alias becomes orphaned.
void (null as unknown as EngineMaskedRegion | EngineTokenEntry);
