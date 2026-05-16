/**
 * RecognizerMissStore — bulk-insert helper for vs_recognizer_misses.
 *
 * The engine returns a per-request list of misses in /redact response.
 * The gateway calls ``store.recordBatch(misses)`` once per request.
 * Best-effort: a DB hiccup logs but doesn't fail the request (the
 * audit trail is what matters; this table is the queryable index for
 * the admin UI's recognizer-tuning view).
 */

import { desc } from 'drizzle-orm';
import {
  recognizerMisses,
  type NewRecognizerMiss,
} from '../schema/recognizer-misses.js';
import type { Database } from '../db/index.js';

export interface RecognizerMissInput {
  pattern: string;
  sampleHash: string;
  severity: string;
}

export class RecognizerMissStore {
  constructor(private readonly db: Database) {}

  async recordBatch(misses: readonly RecognizerMissInput[]): Promise<void> {
    if (misses.length === 0) return;
    const rows: NewRecognizerMiss[] = misses.map((m) => ({
      pattern: m.pattern,
      sampleHash: m.sampleHash,
      severity: m.severity,
    }));
    await this.db.insert(recognizerMisses).values(rows);
  }

  async count(): Promise<number> {
    const rows = await this.db
      .select({ id: recognizerMisses.id })
      .from(recognizerMisses);
    return rows.length;
  }

  /**
   * Admin UI helper (v1.1 §3.3): list recent misses, newest first.
   * ``limit`` capped at 500.
   */
  async listRecent(opts: { limit?: number } = {}): Promise<AdminMissView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = await this.db
      .select()
      .from(recognizerMisses)
      .orderBy(desc(recognizerMisses.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      sampleHash: r.sampleHash,
      severity: r.severity,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export interface AdminMissView {
  id: string;
  pattern: string;
  sampleHash: string;
  severity: string;
  createdAt: string;
}
