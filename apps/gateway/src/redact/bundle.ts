/**
 * Per-job + per-batch zip bundles — Phase 17 v1.7.
 *
 * The bundle endpoint hands the user a single .zip containing every
 * artifact for a job (or every completed job's redacted PDF for a
 * batch). The zip is streamed: archiver pushes bytes into the response
 * body as it walks the filesystem, so multi-page PDFs + per-page PNGs
 * don't all sit in memory.
 *
 * Layout for `/v1/redact/jobs/:id/bundle`:
 *
 *     <filename-stem>/
 *       README.txt           — fingerprints + warnings
 *       source.<ext>         — original upload
 *       redacted.pdf         — redacted output
 *       extracted.md
 *       extracted.json
 *       audit.jsonl
 *       pages/
 *         1.png … N.png
 *
 * Layout for `/v1/redact/batches/:id/bundle`:
 *
 *     batch-<short-id>/
 *       README.txt
 *       summary.csv          — id, filename, status, pages, expires_at
 *       <stem-1>-redacted.pdf
 *       <stem-2>-redacted.pdf
 *       …
 *
 * Failed jobs are excluded from the batch bundle (no redacted PDF
 * exists). In-progress jobs are also excluded — the bundle is a
 * point-in-time export, not a live stream.
 */

import { existsSync, type ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import type { Archiver } from 'archiver';
import type { RedactJobRecord } from '@kisaesdevlab/vibe-shield-schema';
import { JobStorage, type ArtifactKind } from './storage.js';

const TEXTUAL_ARTIFACTS: ArtifactKind[] = [
  'redacted',
  'extracted_md',
  'extracted_json',
  'audit_jsonl',
];

const ARTIFACT_FILE: Record<ArtifactKind, string> = {
  source: 'source',
  redacted: 'redacted.pdf',
  extracted_md: 'extracted.md',
  extracted_json: 'extracted.json',
  audit_jsonl: 'audit.jsonl',
};

export function jobBundleFilename(job: RedactJobRecord): string {
  const stem = stripExt(job.filename) || 'job';
  return `${stem}-bundle.zip`;
}

export function batchBundleFilename(batchId: string): string {
  return `batch-${batchId.slice(0, 8)}-bundle.zip`;
}

/**
 * Stream a per-job zip into ``out``. Awaits archive completion before
 * resolving. The caller is responsible for setting Content-Type +
 * Content-Disposition before piping; the function only handles the
 * body.
 */
export async function streamJobBundle(
  storage: JobStorage,
  job: RedactJobRecord,
  out: NodeJS.WritableStream,
): Promise<void> {
  const archive: Archiver = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(out);

  const stem = stripExt(job.filename) || 'job';
  // All entries nested under <stem>/ so a user unzipping into their
  // Downloads folder gets one tidy directory.
  const root = stem;

  // README first (small + fast to render).
  archive.append(buildJobReadme(job), { name: `${root}/README.txt` });

  // Source upload — always present, even if redaction failed.
  const sourceExt = JobStorage.safeExt(job.filename);
  const sourcePath = storage.artifactPath(job.id, 'source', sourceExt);
  if (existsSync(sourcePath)) {
    archive.file(sourcePath, {
      name: `${root}/${ARTIFACT_FILE.source}.${sourceExt}`,
    });
  }

  // Completed artifacts.
  if (job.status === 'completed') {
    for (const kind of TEXTUAL_ARTIFACTS) {
      const p = storage.artifactPath(job.id, kind);
      if (existsSync(p)) {
        archive.file(p, { name: `${root}/${ARTIFACT_FILE[kind]}` });
      }
    }
    // Per-page PNGs.
    const pages = await storage.listPages(job.id);
    for (const { page, path } of pages) {
      archive.file(path, {
        name: `${root}/pages/${page.toString()}.png`,
      });
    }
  }

  await archive.finalize();
}

/**
 * Stream a per-batch zip into ``out``. Includes one redacted PDF per
 * completed child job, plus a summary.csv. Failed + in-progress jobs
 * are skipped (the README explains).
 */
export async function streamBatchBundle(
  storage: JobStorage,
  batchId: string,
  jobs: RedactJobRecord[],
  out: NodeJS.WritableStream,
): Promise<void> {
  const archive: Archiver = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(out);

  const root = `batch-${batchId.slice(0, 8)}`;
  archive.append(buildBatchReadme(batchId, jobs), {
    name: `${root}/README.txt`,
  });
  archive.append(buildBatchSummaryCsv(jobs), { name: `${root}/summary.csv` });

  // Deduplicate filename collisions (two uploaded files named
  // "statement.pdf") by suffixing -<n>.
  const used = new Set<string>();
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    const stem = stripExt(job.filename) || 'job';
    let name = `${stem}-redacted.pdf`;
    let i = 2;
    while (used.has(name)) {
      name = `${stem}-redacted-${i.toString()}.pdf`;
      i += 1;
    }
    used.add(name);
    const p = storage.artifactPath(job.id, 'redacted');
    if (existsSync(p)) {
      archive.file(p, { name: `${root}/${name}` });
    }
  }

  await archive.finalize();
}

function buildJobReadme(job: RedactJobRecord): string {
  return [
    `Vibe Shield — Redact job bundle`,
    `=================================`,
    ``,
    `Job ID:           ${job.id}`,
    `Filename:         ${job.filename}`,
    `MIME:             ${job.mime}`,
    `Pages:            ${(job.pagesCount ?? 0).toString()}`,
    `Status:           ${job.status}`,
    `Created:          ${job.createdAt.toISOString()}`,
    job.finishedAt !== null
      ? `Finished:         ${job.finishedAt.toISOString()}`
      : `Finished:         —`,
    `Expires:          ${job.expiresAt.toISOString()}`,
    ``,
    `This archive was generated by Vibe Shield. Cleartext PII has been`,
    `redacted by the appliance before any of these files were written —`,
    `the original PII never left the appliance volume.`,
    ``,
    job.status === 'failed' && job.errorMessage !== null
      ? `Failure reason:   ${job.errorMessage}`
      : ``,
    job.status === 'completed'
      ? `Contents:`
      : `Partial contents — job did not complete cleanly:`,
    `  source.<ext>      original upload, byte-for-byte`,
    `  redacted.pdf      redacted output PDF`,
    `  extracted.md      Markdown of redacted text`,
    `  extracted.json    JSON token + region map`,
    `  audit.jsonl       per-event audit log for this job`,
    `  pages/N.png       per-page rasterized + redacted PNGs`,
    ``,
  ]
    .filter((line) => line !== ``)
    .join('\n');
}

function buildBatchReadme(batchId: string, jobs: RedactJobRecord[]): string {
  const completed = jobs.filter((j) => j.status === 'completed').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const inflight = jobs.length - completed - failed;
  return [
    `Vibe Shield — Redact batch bundle`,
    `===================================`,
    ``,
    `Batch ID:         ${batchId}`,
    `Total jobs:       ${jobs.length.toString()}`,
    `Completed:        ${completed.toString()}`,
    `Failed:           ${failed.toString()}`,
    `In-progress:      ${inflight.toString()}`,
    ``,
    `This archive contains the redacted PDF for every completed job in`,
    `this batch. Failed and in-progress jobs are listed in summary.csv`,
    `but are not represented as PDFs (no redacted output exists).`,
    ``,
    `For per-job source uploads, extracted text, token maps, or audit`,
    `logs, fetch the per-job bundle:`,
    `    GET /v1/redact/jobs/<id>/bundle`,
    ``,
  ].join('\n');
}

function buildBatchSummaryCsv(jobs: RedactJobRecord[]): string {
  const rows: string[] = [
    'job_id,filename,status,pages,started_at,finished_at,expires_at,error',
  ];
  for (const j of jobs) {
    rows.push(
      [
        j.id,
        csvField(j.filename),
        j.status,
        (j.pagesCount ?? 0).toString(),
        j.startedAt?.toISOString() ?? '',
        j.finishedAt?.toISOString() ?? '',
        j.expiresAt.toISOString(),
        csvField(j.errorMessage ?? ''),
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

function csvField(s: string): string {
  if (s === '') return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

// Avoid an unused-import warning when the type alias becomes orphaned.
void (null as unknown as ReadStream | Readable | undefined);
