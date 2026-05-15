/**
 * RecognizerMissStore — bulk-insert helper for vs_recognizer_misses.
 *
 * The engine returns a per-request list of misses in /redact response.
 * The gateway calls ``store.recordBatch(misses)`` once per request.
 * Best-effort: a DB hiccup logs but doesn't fail the request (the
 * audit trail is what matters; this table is the queryable index for
 * the admin UI's recognizer-tuning view).
 */

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
}
