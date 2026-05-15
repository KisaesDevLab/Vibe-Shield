import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';

const bytea = customType<{ data: Buffer; default: false; notNull: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * vs_audit — append-only event log.
 *
 * Hard rule #1 / BUILD_PLAN §11: ``payload_hash`` carries the SHA-256 of
 * the request/response *body*; cleartext is never written here. A
 * Postgres trigger (see migrations/0001_initial.sql) rejects UPDATE and
 * DELETE on this table — row-level immutability is enforced in-database,
 * not by application discipline.
 */
export const audit = pgTable(
  'vs_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    eventType: text('event_type').notNull(),
    payloadHash: bytea('payload_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_audit_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('vs_audit_event_idx').on(table.eventType),
  ],
);

export type AuditEvent = typeof audit.$inferSelect;
export type NewAuditEvent = typeof audit.$inferInsert;
