import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * vs_recognizer_misses — the audit sink for Phase 4 BackstopLayer hits
 * that Presidio missed. ``sample_hash`` is the SHA-256-truncated hash
 * already produced by the engine; this table never holds cleartext.
 *
 * Severity is stored as a free-text column (rather than an enum) so the
 * Python engine and Node gateway can evolve the ladder independently
 * without a schema migration. App-layer validation enforces the
 * ``block``/``warn``/``allow`` set today.
 */
export const recognizerMisses = pgTable(
  'vs_recognizer_misses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pattern: text('pattern').notNull(),
    sampleHash: text('sample_hash').notNull(),
    severity: text('severity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_recognizer_misses_pattern_idx').on(table.pattern),
    index('vs_recognizer_misses_created_idx').on(table.createdAt),
  ],
);

export type RecognizerMiss = typeof recognizerMisses.$inferSelect;
export type NewRecognizerMiss = typeof recognizerMisses.$inferInsert;
