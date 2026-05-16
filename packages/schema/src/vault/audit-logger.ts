/**
 * Audit logger for vs_audit.
 *
 * BUILD_PLAN §11: every request, every re-identification, every
 * recognizer miss, every policy change. ``payload_hash`` carries the
 * SHA-256 of the request/response body — never the body itself. The
 * append-only trigger from migration 0001 enforces immutability at
 * the row level.
 *
 * Hash-chain tamper evidence (BUILD_PLAN §11 "Daily audit digest
 * signed + stored (hash-chained)"): the daily digest is computed by
 * ``computeDailyDigest`` over all rows for a given day, ordered by
 * (created_at, id). The result is a single SHA-256 hash that's
 * persisted to ``compliance/audit-digests/<YYYY-MM-DD>.txt`` for
 * tamper evidence (Phase 22 wires up the daily cron).
 */

import { createHash } from 'node:crypto';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { audit } from '../schema/audit.js';
import type { Database } from '../db/index.js';

export type AuditEventType =
  | 'request'
  | 'reidentify'
  | 'materialize'
  | 'recognizer_miss'
  | 'policy_change'
  | 'session_create'
  | 'session_purge'
  | 'api_key_issue'
  | 'api_key_revoke'
  | 'spend_cap_breached'
  | 'rate_limit_breached'
  | 'commercial_key_probe';

export interface AuditEntry {
  tenantId: string;
  sessionId?: string;
  eventType: AuditEventType;
  /** Whatever the application would have logged as the body — we hash it. */
  payload: unknown;
}

export class AuditLogger {
  constructor(private readonly db: Database) {}

  /**
   * Append a row to vs_audit. Throws on DB error; the caller decides
   * whether to fail the request or proceed (a missing audit on a
   * sensitive event should fail-closed; a missing audit on a routine
   * request should be tolerated to avoid making the audit subsystem a
   * single point of failure).
   */
  async append(entry: AuditEntry): Promise<void> {
    const payloadHash = sha256(safeStringify(entry.payload));
    await this.db.insert(audit).values({
      tenantId: entry.tenantId,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      eventType: entry.eventType,
      payloadHash,
    });
  }

  /**
   * Compute the hash-chained daily digest for ``date``. SHA-256 of the
   * concatenation of every row's payload_hash for that day, in
   * ``(created_at, id)`` order. Idempotent.
   */
  async computeDailyDigest(date: Date): Promise<Buffer> {
    const dayStart = startOfDayUtc(date);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const rows = await this.db
      .select({ id: audit.id, payloadHash: audit.payloadHash })
      .from(audit)
      .where(and(gte(audit.createdAt, dayStart), lt(audit.createdAt, dayEnd)))
      .orderBy(asc(audit.createdAt), asc(audit.id));
    const h = createHash('sha256');
    for (const row of rows) {
      h.update(row.payloadHash);
      h.update(Buffer.from(row.id, 'utf8'));
    }
    return h.digest();
  }

  /**
   * Count of audit rows for a tenant over a time window. Used by the
   * Phase 13 admin dashboard.
   */
  async countForTenant(
    tenantId: string,
    eventType?: AuditEventType,
  ): Promise<number> {
    const where =
      eventType !== undefined
        ? and(eq(audit.tenantId, tenantId), eq(audit.eventType, eventType))
        : eq(audit.tenantId, tenantId);
    const rows = await this.db.select({ id: audit.id }).from(audit).where(where);
    return rows.length;
  }
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/**
 * Canonical-JSON stringify for audit-payload hashing.
 *
 * v1.1 §3.9: replace the v1.0 shallow-key-sort with a recursive walk
 * so nested objects are also key-sorted. Audit hashes are tamper-
 * evidence material — operators verifying by hand need deterministic
 * output that doesn't depend on engine V8 internals or property
 * insertion order.
 *
 * Properties:
 *   - Object keys sorted lexicographically at every depth.
 *   - Arrays preserve order (semantically meaningful).
 *   - undefined values dropped from objects (matches JSON.stringify).
 *   - undefined values in arrays serialize as null (matches JSON.stringify).
 *   - bigint -> string with "n" suffix (JSON.stringify throws otherwise).
 *   - Cycles throw — should never appear in audit payloads, hard fail.
 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) {
    throw new Error('safeStringify: cyclic reference detected');
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    const out = value.map((v) => (v === undefined ? null : canonicalize(v, seen)));
    seen.delete(value as object);
    return out;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = canonicalize(v, seen);
  }
  seen.delete(value as object);
  return out;
}

function startOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0),
  );
}
