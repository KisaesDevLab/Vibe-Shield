/**
 * ScanJobStore — Phase 26 (v1.8 foundation).
 *
 * Mirrors the RedactJobStore shape: pending → running → (completed |
 * failed). Workers transition rows via mark* methods; the engine
 * streams findings which the gateway pipeline persists into the
 * companion vs_scan_files + vs_scan_findings tables via the helper
 * methods below.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { scanFiles, scanFindings, scanJobs } from '../schema/scan-jobs.js';

export type ScanJobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ScanSeverity = 'low' | 'medium' | 'high';

export interface ScanJobRecord {
  id: string;
  userId: string;
  sourceKind: 'file' | 'archive';
  sourceName: string;
  sourceMime: string;
  sourceSizeBytes: number;
  filesCount: number;
  findingsCount: number;
  findingsHigh: number;
  findingsMedium: number;
  findingsLow: number;
  status: ScanJobStatus;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ScanFileRecord {
  id: string;
  jobId: string;
  path: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  skippedReason: string | null;
  createdAt: Date;
}

export interface ScanFindingRecord {
  id: string;
  jobId: string;
  fileId: string;
  entityType: string;
  severity: ScanSeverity;
  location: string;
  snippetRedacted: string;
  sampleHash: string;
  suppressed: boolean;
  createdAt: Date;
}

export interface CreateScanJobInput {
  userId: string;
  sourceKind: 'file' | 'archive';
  sourceName: string;
  sourceMime: string;
  sourceSizeBytes: number;
}

export interface AddScanFileInput {
  jobId: string;
  path: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  skippedReason?: string;
}

export interface AddScanFindingInput {
  jobId: string;
  fileId: string;
  entityType: string;
  severity: ScanSeverity;
  location: string;
  snippetRedacted: string;
  sampleHash: string;
}

export class ScanJobNotFoundError extends Error {
  override readonly name = 'ScanJobNotFoundError';
}

export class ScanJobStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateScanJobInput): Promise<ScanJobRecord> {
    const [row] = await this.db
      .insert(scanJobs)
      .values({
        userId: input.userId,
        sourceKind: input.sourceKind,
        sourceName: input.sourceName,
        sourceMime: input.sourceMime,
        sourceSizeBytes: input.sourceSizeBytes,
      })
      .returning();
    if (row === undefined) throw new Error('insert returned no rows');
    return toJobRecord(row);
  }

  async findById(id: string): Promise<ScanJobRecord | null> {
    const rows = await this.db
      .select()
      .from(scanJobs)
      .where(eq(scanJobs.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toJobRecord(row);
  }

  async listForUser(userId: string, limit = 50): Promise<ScanJobRecord[]> {
    const cap = Math.min(Math.max(limit, 1), 200);
    const rows = await this.db
      .select()
      .from(scanJobs)
      .where(eq(scanJobs.userId, userId))
      .orderBy(desc(scanJobs.createdAt))
      .limit(cap);
    return rows.map(toJobRecord);
  }

  async listAll(limit = 50): Promise<ScanJobRecord[]> {
    const cap = Math.min(Math.max(limit, 1), 200);
    const rows = await this.db
      .select()
      .from(scanJobs)
      .orderBy(desc(scanJobs.createdAt))
      .limit(cap);
    return rows.map(toJobRecord);
  }

  async markRunning(id: string): Promise<void> {
    await this.db
      .update(scanJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(scanJobs.id, id));
  }

  async markCompleted(id: string): Promise<void> {
    await this.db
      .update(scanJobs)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(scanJobs.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(scanJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: errorMessage.slice(0, 1000),
      })
      .where(eq(scanJobs.id, id));
  }

  async delete(id: string): Promise<void> {
    // Cascade deletes children in scan_files + scan_findings.
    await this.db.delete(scanJobs).where(eq(scanJobs.id, id));
  }

  // ---- Child rows ----------------------------------------------

  async addFile(input: AddScanFileInput): Promise<ScanFileRecord> {
    const [row] = await this.db
      .insert(scanFiles)
      .values({
        jobId: input.jobId,
        path: input.path,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        ...(input.skippedReason !== undefined
          ? { skippedReason: input.skippedReason }
          : {}),
      })
      .returning();
    if (row === undefined) throw new Error('insert returned no rows');
    await this.db
      .update(scanJobs)
      .set({ filesCount: sql`${scanJobs.filesCount} + 1` })
      .where(eq(scanJobs.id, input.jobId));
    return toFileRecord(row);
  }

  async addFinding(input: AddScanFindingInput): Promise<ScanFindingRecord> {
    const [row] = await this.db
      .insert(scanFindings)
      .values({
        jobId: input.jobId,
        fileId: input.fileId,
        entityType: input.entityType,
        severity: input.severity,
        location: input.location,
        snippetRedacted: input.snippetRedacted,
        sampleHash: input.sampleHash,
      })
      .returning();
    if (row === undefined) throw new Error('insert returned no rows');

    const severityColumn =
      input.severity === 'high'
        ? scanJobs.findingsHigh
        : input.severity === 'medium'
          ? scanJobs.findingsMedium
          : scanJobs.findingsLow;
    await this.db
      .update(scanJobs)
      .set({
        findingsCount: sql`${scanJobs.findingsCount} + 1`,
        findingsHigh:
          input.severity === 'high'
            ? sql`${scanJobs.findingsHigh} + 1`
            : scanJobs.findingsHigh,
        findingsMedium:
          input.severity === 'medium'
            ? sql`${scanJobs.findingsMedium} + 1`
            : scanJobs.findingsMedium,
        findingsLow:
          input.severity === 'low'
            ? sql`${scanJobs.findingsLow} + 1`
            : scanJobs.findingsLow,
      })
      .where(eq(scanJobs.id, input.jobId));
    void severityColumn;
    return toFindingRecord(row);
  }

  async listFiles(jobId: string): Promise<ScanFileRecord[]> {
    const rows = await this.db
      .select()
      .from(scanFiles)
      .where(eq(scanFiles.jobId, jobId))
      .orderBy(scanFiles.path);
    return rows.map(toFileRecord);
  }

  async listFindings(
    jobId: string,
    opts: {
      severity?: ScanSeverity;
      entityType?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ScanFindingRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const conditions = [eq(scanFindings.jobId, jobId)];
    if (opts.severity !== undefined) {
      conditions.push(eq(scanFindings.severity, opts.severity));
    }
    if (opts.entityType !== undefined) {
      conditions.push(eq(scanFindings.entityType, opts.entityType));
    }
    const rows = await this.db
      .select()
      .from(scanFindings)
      .where(and(...conditions))
      .orderBy(desc(scanFindings.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map(toFindingRecord);
  }
}

function toJobRecord(row: typeof scanJobs.$inferSelect): ScanJobRecord {
  return {
    id: row.id,
    userId: row.userId,
    sourceKind: row.sourceKind as 'file' | 'archive',
    sourceName: row.sourceName,
    sourceMime: row.sourceMime,
    sourceSizeBytes: row.sourceSizeBytes,
    filesCount: row.filesCount,
    findingsCount: row.findingsCount,
    findingsHigh: row.findingsHigh,
    findingsMedium: row.findingsMedium,
    findingsLow: row.findingsLow,
    status: row.status as ScanJobStatus,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function toFileRecord(row: typeof scanFiles.$inferSelect): ScanFileRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    path: row.path,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    skippedReason: row.skippedReason,
    createdAt: row.createdAt,
  };
}

function toFindingRecord(
  row: typeof scanFindings.$inferSelect,
): ScanFindingRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    fileId: row.fileId,
    entityType: row.entityType,
    severity: row.severity as ScanSeverity,
    location: row.location,
    snippetRedacted: row.snippetRedacted,
    sampleHash: row.sampleHash,
    suppressed: row.suppressed,
    createdAt: row.createdAt,
  };
}
