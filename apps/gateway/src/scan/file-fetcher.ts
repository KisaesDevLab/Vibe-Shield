/**
 * ScanFileFetcher implementations — Phase 26 v1.9.
 *
 * The bulk-redact endpoint needs the original bytes of a scanned
 * file to hand off to the Redact pipeline. For scheduled scans the
 * bytes still live on the appliance volume; for one-shot uploads
 * they don't, and the fetcher returns null.
 *
 * Path safety: the filesystem fetcher refuses any path that resolves
 * outside ``scanRoot`` (a CRITICAL hard rule — we mustn't let a
 * malicious vs_scan_files row drag the gateway into reading
 * /etc/shadow).
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type { ScanFileFetcher } from '../routes/scan.js';
import type { ScanJobStore } from '@kisaesdevlab/vibe-shield-schema';

export interface FilesystemScanFileFetcherDeps {
  scanRoot: string;
  scanJobs: ScanJobStore;
  logger: Logger;
}

export class FilesystemScanFileFetcher implements ScanFileFetcher {
  constructor(private readonly deps: FilesystemScanFileFetcherDeps) {}

  async fetch(args: {
    jobId: string;
    filePath: string;
  }): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
    const safe = resolveSafe(this.deps.scanRoot, args.filePath);
    if (safe === null) {
      this.deps.logger.warn(
        { scan_job_id: args.jobId, path: args.filePath },
        'bulk-redact fetch refused: path escapes scan root',
      );
      return null;
    }
    let info;
    try {
      info = await stat(safe);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const bytes = await readFile(safe);
    const mime = mimeFromExt(extname(safe));
    const filename = safe.slice(safe.lastIndexOf(sep) + 1);
    return { bytes, mime, filename };
  }
}

function resolveSafe(scanRoot: string, ref: string): string | null {
  // Bulk-redact links currently target one scan_files.path; archive
  // inner paths use "outer!inner" notation. We refuse those — the
  // bytes don't live anywhere we can fetch them from.
  if (ref.includes('!')) return null;
  const root = resolve(scanRoot);
  const target = resolve(scanRoot, ref);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.txt' || e === '.md' || e === '.log') return 'text/plain';
  if (e === '.pdf') return 'application/pdf';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.tif' || e === '.tiff') return 'image/tiff';
  if (e === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}
