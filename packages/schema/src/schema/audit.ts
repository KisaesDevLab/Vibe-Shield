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
 *
 * Phase 23.5 added ``module`` / ``actor_type`` / ``service_name`` (UI-
 * Build-Addendum §4.6) so events can be filtered by product module
 * (redact / scan / compliance / identity / egress / admin) and so
 * service-attributed events from the internal API (Phase 28) carry the
 * caller's name. Historic rows are backfilled by migration 0004; new
 * inserts require ``module``.
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
    /** Product module the event belongs to. Nullable for v1.0–v1.1
     *  history; the application layer always supplies a value on insert. */
    module: text('module'),
    /** Who initiated the event. 'user' (default, gateway/admin caller),
     *  'service' (Phase 28 internal-API call from another Vibe app),
     *  'system' (background cron / reprobe / migrations). */
    actorType: text('actor_type').notNull().default('user'),
    /** Populated when ``actor_type='service'``; the short name the
     *  service-key registry maps to (e.g. ``mybooks``). */
    serviceName: text('service_name'),
    payloadHash: bytea('payload_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('vs_audit_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('vs_audit_event_idx').on(table.eventType),
    index('vs_audit_module_idx').on(table.module),
  ],
);

export type AuditEvent = typeof audit.$inferSelect;
export type NewAuditEvent = typeof audit.$inferInsert;
