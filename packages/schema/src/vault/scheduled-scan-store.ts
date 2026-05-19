/**
 * ScheduledScanStore — Phase 26 v1.9.
 *
 * Persistence for the gateway's scheduled-scan loop. Reading +
 * writing only; cron-expression parsing + next-run computation lives
 * in the gateway (we don't want a node-cron dep in the schema pkg).
 */

import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { scheduledScans } from '../schema/scheduled-scans.js';

export interface ScheduledScanRecord {
  id: string;
  userId: string;
  name: string;
  sourceKind: string;
  sourceRef: string;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastRunJobId: string | null;
  nextRunAt: Date | null;
  notifyEmails: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  alertMinSeverity: 'low' | 'medium' | 'high';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateScheduledScanInput {
  userId: string;
  name: string;
  sourceKind: string;
  sourceRef: string;
  cronExpression: string;
  enabled?: boolean;
  notifyEmails?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  alertMinSeverity?: 'low' | 'medium' | 'high';
  nextRunAt?: Date;
}

export interface UpdateScheduledScanInput {
  name?: string;
  cronExpression?: string;
  enabled?: boolean;
  notifyEmails?: string | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  alertMinSeverity?: 'low' | 'medium' | 'high';
}

export class ScheduledScanNotFoundError extends Error {
  override readonly name = 'ScheduledScanNotFoundError';
}

export class ScheduledScanStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateScheduledScanInput): Promise<ScheduledScanRecord> {
    const [row] = await this.db
      .insert(scheduledScans)
      .values({
        userId: input.userId,
        name: input.name,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        cronExpression: input.cronExpression,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.notifyEmails !== undefined
          ? { notifyEmails: input.notifyEmails }
          : {}),
        ...(input.webhookUrl !== undefined
          ? { webhookUrl: input.webhookUrl }
          : {}),
        ...(input.webhookSecret !== undefined
          ? { webhookSecret: input.webhookSecret }
          : {}),
        ...(input.alertMinSeverity !== undefined
          ? { alertMinSeverity: input.alertMinSeverity }
          : {}),
        ...(input.nextRunAt !== undefined ? { nextRunAt: input.nextRunAt } : {}),
      })
      .returning();
    if (row === undefined) throw new Error('insert returned no rows');
    return toRecord(row);
  }

  async findById(id: string): Promise<ScheduledScanRecord | null> {
    const rows = await this.db
      .select()
      .from(scheduledScans)
      .where(eq(scheduledScans.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listForUser(userId: string): Promise<ScheduledScanRecord[]> {
    const rows = await this.db
      .select()
      .from(scheduledScans)
      .where(eq(scheduledScans.userId, userId))
      .orderBy(desc(scheduledScans.createdAt));
    return rows.map(toRecord);
  }

  async listAll(): Promise<ScheduledScanRecord[]> {
    const rows = await this.db
      .select()
      .from(scheduledScans)
      .orderBy(desc(scheduledScans.createdAt));
    return rows.map(toRecord);
  }

  /** Pull every enabled row whose next_run_at is <= now. */
  async listDue(now: Date = new Date()): Promise<ScheduledScanRecord[]> {
    const rows = await this.db
      .select()
      .from(scheduledScans)
      .where(
        and(
          eq(scheduledScans.enabled, true),
          lte(scheduledScans.nextRunAt, now),
        ),
      )
      .orderBy(asc(scheduledScans.nextRunAt));
    return rows.map(toRecord);
  }

  async update(
    id: string,
    input: UpdateScheduledScanInput,
  ): Promise<ScheduledScanRecord> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.cronExpression !== undefined) {
      patch['cronExpression'] = input.cronExpression;
    }
    if (input.enabled !== undefined) patch['enabled'] = input.enabled;
    if (input.notifyEmails !== undefined) {
      patch['notifyEmails'] = input.notifyEmails;
    }
    if (input.webhookUrl !== undefined) patch['webhookUrl'] = input.webhookUrl;
    if (input.webhookSecret !== undefined) {
      patch['webhookSecret'] = input.webhookSecret;
    }
    if (input.alertMinSeverity !== undefined) {
      patch['alertMinSeverity'] = input.alertMinSeverity;
    }
    const [row] = await this.db
      .update(scheduledScans)
      .set(patch)
      .where(eq(scheduledScans.id, id))
      .returning();
    if (row === undefined) {
      throw new ScheduledScanNotFoundError(`scheduled scan ${id} not found`);
    }
    return toRecord(row);
  }

  async markRun(
    id: string,
    lastRunJobId: string | null,
    nextRunAt: Date | null,
    runAt: Date = new Date(),
  ): Promise<void> {
    await this.db
      .update(scheduledScans)
      .set({
        lastRunAt: runAt,
        lastRunJobId,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(scheduledScans.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(scheduledScans).where(eq(scheduledScans.id, id));
  }
}

function toRecord(
  row: typeof scheduledScans.$inferSelect,
): ScheduledScanRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    sourceKind: row.sourceKind,
    sourceRef: row.sourceRef,
    cronExpression: row.cronExpression,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    lastRunJobId: row.lastRunJobId,
    nextRunAt: row.nextRunAt,
    notifyEmails: row.notifyEmails,
    webhookUrl: row.webhookUrl,
    webhookSecret: row.webhookSecret,
    alertMinSeverity: row.alertMinSeverity as 'low' | 'medium' | 'high',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
