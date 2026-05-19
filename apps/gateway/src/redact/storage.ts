/**
 * On-disk artifact storage for the Redact module — Phase D + Phase 17
 * v1.4. The DB row in ``vs_redact_jobs`` is metadata; the actual
 * bytes (source PDF, redacted PDF, extracted markdown + JSON, audit
 * log) live under ``<base>/<job_id>/`` on the appliance volume.
 *
 * Layout (matches UI-Build-Addendum §4.2):
 *
 *     <base>/
 *       <job_id>/
 *         source.<ext>       — operator's upload, byte-for-byte
 *         pages/             — per-page rasterized PNGs (1.png, 2.png, …)
 *         redacted.pdf       — re-assembled redacted output
 *         extracted.md       — markdown of the OCR'd text (post-redaction)
 *         extracted.json     — structured tokens + per-page metadata
 *         audit.jsonl        — JSONL audit trail for this job
 *
 * Path safety: ``jobId`` is always a UUID emitted by Postgres. We
 * validate against a strict UUID pattern before joining into a path
 * so a malicious caller can't traverse with ``..`` or absolute paths.
 *
 * The base directory comes from ``REDACT_JOBS_DIR`` env var (default
 * ``/var/lib/vibe-shield/redact/jobs`` matching the appliance volume
 * mount). Tests inject a tmpdir.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const DEFAULT_REDACT_JOBS_DIR = '/var/lib/vibe-shield/redact/jobs';

export type ArtifactKind =
  | 'source'
  | 'redacted'
  | 'extracted_md'
  | 'extracted_json'
  | 'audit_jsonl';

const ARTIFACT_FILENAMES: Record<ArtifactKind, string> = {
  source: 'source',
  redacted: 'redacted.pdf',
  extracted_md: 'extracted.md',
  extracted_json: 'extracted.json',
  audit_jsonl: 'audit.jsonl',
};

const ARTIFACT_MIMES: Record<ArtifactKind, string> = {
  source: 'application/octet-stream',
  redacted: 'application/pdf',
  extracted_md: 'text/markdown; charset=utf-8',
  extracted_json: 'application/json',
  audit_jsonl: 'application/jsonl',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidJobIdError extends Error {
  override readonly name = 'InvalidJobIdError';
}

export class ArtifactNotFoundError extends Error {
  override readonly name = 'ArtifactNotFoundError';
}

export interface JobStorageOptions {
  /** Override base directory (defaults to ``REDACT_JOBS_DIR`` env or
   *  the system default). */
  baseDir?: string;
}

export class JobStorage {
  private readonly baseDir: string;

  constructor(opts: JobStorageOptions = {}) {
    this.baseDir = resolve(
      opts.baseDir ??
        process.env['REDACT_JOBS_DIR'] ??
        DEFAULT_REDACT_JOBS_DIR,
    );
  }

  /**
   * Validate + resolve the per-job directory path. Throws on a
   * non-UUID id or any path-traversal attempt.
   *
   * The UUID gate is the real safety; this is belt-and-braces in
   * case validation is ever relaxed. Compare against ``baseDir + sep``
   * so Windows (``\``) and POSIX (``/``) both work.
   */
  jobDir(jobId: string): string {
    if (!UUID_RE.test(jobId)) {
      throw new InvalidJobIdError(`invalid job id: ${jobId}`);
    }
    const joined = normalize(join(this.baseDir, jobId));
    const baseWithSep = this.baseDir.endsWith(sep)
      ? this.baseDir
      : this.baseDir + sep;
    if (!joined.startsWith(baseWithSep) && joined !== this.baseDir) {
      throw new InvalidJobIdError(`path traversal in job id: ${jobId}`);
    }
    return joined;
  }

  /** Create the per-job directory + pages/ subdir. Idempotent. */
  async ensureJobDir(jobId: string): Promise<string> {
    const dir = this.jobDir(jobId);
    await mkdir(join(dir, 'pages'), { recursive: true });
    return dir;
  }

  /**
   * Path for a named artifact. ``source`` extension is appended by
   * the caller (we don't know it until upload time).
   */
  artifactPath(
    jobId: string,
    kind: ArtifactKind,
    sourceExt?: string,
  ): string {
    const dir = this.jobDir(jobId);
    if (kind === 'source') {
      const ext = sourceExt === undefined ? '' : `.${sourceExt.replace(/^\.+/, '')}`;
      return join(dir, `source${ext}`);
    }
    return join(dir, ARTIFACT_FILENAMES[kind]);
  }

  /** Per-page rasterized image path. 1-indexed. */
  pagePath(jobId: string, pageNumber: number): string {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new Error(`invalid page number: ${pageNumber.toString()}`);
    }
    return join(this.jobDir(jobId), 'pages', `${pageNumber.toString()}.png`);
  }

  async writeSource(
    jobId: string,
    sourceExt: string,
    bytes: Buffer,
  ): Promise<{ path: string; size: number }> {
    await this.ensureJobDir(jobId);
    const path = this.artifactPath(jobId, 'source', sourceExt);
    await writeFile(path, bytes);
    return { path, size: bytes.length };
  }

  async writeArtifact(
    jobId: string,
    kind: Exclude<ArtifactKind, 'source'>,
    bytes: Buffer | string,
  ): Promise<void> {
    await this.ensureJobDir(jobId);
    const path = this.artifactPath(jobId, kind);
    if (typeof bytes === 'string') {
      await writeFile(path, bytes, 'utf8');
    } else {
      await writeFile(path, bytes);
    }
  }

  async writePage(
    jobId: string,
    pageNumber: number,
    bytes: Buffer,
  ): Promise<void> {
    await this.ensureJobDir(jobId);
    await writeFile(this.pagePath(jobId, pageNumber), bytes);
  }

  /**
   * Append a single JSONL audit line. Stores in audit.jsonl under
   * the job directory.
   */
  async appendAudit(jobId: string, entry: unknown): Promise<void> {
    await this.ensureJobDir(jobId);
    const line = JSON.stringify(entry) + '\n';
    const path = this.artifactPath(jobId, 'audit_jsonl');
    // Open in append mode via writeFile with flag 'a'. Concurrent
    // appends from the same process serialize at the libuv layer.
    await writeFile(path, line, { flag: 'a', encoding: 'utf8' });
  }

  async readArtifact(jobId: string, kind: ArtifactKind, sourceExt?: string): Promise<Buffer> {
    const path = this.artifactPath(jobId, kind, sourceExt);
    try {
      return await readFile(path);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        throw new ArtifactNotFoundError(`${kind} not found for job ${jobId}`);
      }
      throw err;
    }
  }

  artifactStream(jobId: string, kind: ArtifactKind, sourceExt?: string) {
    return createReadStream(this.artifactPath(jobId, kind, sourceExt));
  }

  async artifactStat(
    jobId: string,
    kind: ArtifactKind,
    sourceExt?: string,
  ): Promise<Stats> {
    const path = this.artifactPath(jobId, kind, sourceExt);
    try {
      return await stat(path);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        throw new ArtifactNotFoundError(`${kind} not found for job ${jobId}`);
      }
      throw err;
    }
  }

  artifactMime(kind: ArtifactKind, sourceMime?: string): string {
    if (kind === 'source' && sourceMime !== undefined) return sourceMime;
    return ARTIFACT_MIMES[kind];
  }

  /** Recursive delete of the job directory. Idempotent. */
  async purgeJob(jobId: string): Promise<void> {
    const dir = this.jobDir(jobId);
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Enumerate the per-page PNGs for a job, in 1-indexed page order.
   * Returns `[]` if no pages/ subdir exists or it's empty. Used by the
   * v1.7 bundle endpoint to add each page PNG to the zip.
   */
  async listPages(jobId: string): Promise<{ page: number; path: string }[]> {
    const pagesDir = join(this.jobDir(jobId), 'pages');
    let entries: string[];
    try {
      entries = await readdir(pagesDir);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw err;
    }
    const out: { page: number; path: string }[] = [];
    for (const name of entries) {
      const m = /^(\d+)\.png$/.exec(name);
      if (m === null) continue;
      const page = Number(m[1]);
      if (!Number.isInteger(page) || page < 1) continue;
      out.push({ page, path: join(pagesDir, name) });
    }
    out.sort((a, b) => a.page - b.page);
    return out;
  }

  /** Extract the source's file extension from a filename safely. */
  static safeExt(filename: string): string {
    const raw = extname(filename).toLowerCase().replace(/^\./, '');
    // Whitelist common doc + image extensions; reject anything else
    // so an attacker can't sneak in 'sh' or a path-traversal piece.
    const allowed = new Set([
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'tif',
      'tiff',
      'bmp',
    ]);
    if (!allowed.has(raw)) {
      return 'bin';
    }
    return raw;
  }
}
