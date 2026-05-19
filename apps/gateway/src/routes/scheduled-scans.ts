/**
 * /v1/scan/scheduled/* — Phase 26 v1.9.
 *
 * CRUD on the vs_scheduled_scans table. ``scan:operator`` can create,
 * ``scan:admin`` (or org_admin) can edit anyone's. cron expressions
 * are validated server-side; the response carries the computed
 * ``next_run_at`` so the SPA can render the human form.
 */

import { Router } from 'express';
import type { Logger } from 'pino';
import {
  ScheduledScanNotFoundError,
  type ScheduledScanRecord,
  type ScheduledScanStore,
} from '@kisaesdevlab/vibe-shield-schema';
import {
  AuthenticationError,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
} from '../errors.js';
import { CronParseError, nextRun } from '../scan/cron.js';

export interface ScheduledScanRoutesDeps {
  store: ScheduledScanStore;
  logger: Logger;
}

export function scheduledScanRouter(deps: ScheduledScanRoutesDeps): Router {
  const router: Router = Router();

  router.post('/v1/scan/scheduled', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const body = parseBody(req.body);
        const next = computeNextOrThrow(body.cronExpression);
        const row = await deps.store.create({
          userId: req.user.id,
          name: body.name,
          sourceKind: body.sourceKind,
          sourceRef: body.sourceRef,
          cronExpression: body.cronExpression,
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(typeof body.notifyEmails === 'string'
            ? { notifyEmails: body.notifyEmails }
            : {}),
          ...(typeof body.webhookUrl === 'string'
            ? { webhookUrl: body.webhookUrl }
            : {}),
          ...(typeof body.webhookSecret === 'string'
            ? { webhookSecret: body.webhookSecret }
            : {}),
          ...(body.alertMinSeverity !== undefined
            ? { alertMinSeverity: body.alertMinSeverity }
            : {}),
          ...(next !== null ? { nextRunAt: next } : {}),
        });
        res.status(201).json(toWire(row));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/scheduled', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const list = isOrgAdminOrScanAdmin(req.user)
          ? await deps.store.listAll()
          : await deps.store.listForUser(req.user.id);
        res.json(list.map(toWire));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/scan/scheduled/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'viewer')) {
          throw new PermissionError('scan viewer role required');
        }
        const row = await fetchOwned(deps.store, req.params.id ?? '', req.user);
        res.json(toWire(row));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.patch('/v1/scan/scheduled/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const existing = await fetchOwned(
          deps.store,
          req.params.id ?? '',
          req.user,
        );
        const patch = parseBody(req.body, { partial: true });
        if (patch.cronExpression !== undefined) {
          computeNextOrThrow(patch.cronExpression);
        }
        const updated = await deps.store.update(existing.id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.cronExpression !== undefined
            ? { cronExpression: patch.cronExpression }
            : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.notifyEmails !== undefined
            ? { notifyEmails: patch.notifyEmails }
            : {}),
          ...(patch.webhookUrl !== undefined ? { webhookUrl: patch.webhookUrl } : {}),
          ...(patch.webhookSecret !== undefined
            ? { webhookSecret: patch.webhookSecret }
            : {}),
          ...(patch.alertMinSeverity !== undefined
            ? { alertMinSeverity: patch.alertMinSeverity }
            : {}),
        });
        res.json(toWire(updated));
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/scan/scheduled/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) throw new AuthenticationError('sign-in required');
        if (!hasScanRole(req.user, 'operator')) {
          throw new PermissionError('scan operator role required');
        }
        const existing = await fetchOwned(
          deps.store,
          req.params.id ?? '',
          req.user,
        );
        await deps.store.delete(existing.id);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

interface ParsedBody {
  name: string;
  sourceKind: string;
  sourceRef: string;
  cronExpression: string;
  enabled: boolean | undefined;
  notifyEmails: string | null | undefined;
  webhookUrl: string | null | undefined;
  webhookSecret: string | null | undefined;
  alertMinSeverity: 'low' | 'medium' | 'high' | undefined;
}

function parseBody(
  raw: unknown,
  opts: { partial?: boolean } = {},
): ParsedBody {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidRequestError('body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const partial = opts.partial === true;

  function reqStr(field: string): string {
    const v = obj[field];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new InvalidRequestError(`${field} is required`);
    }
    return v.trim();
  }

  function optStr(field: string): string | undefined {
    const v = obj[field];
    if (v === undefined) return undefined;
    if (v === null) return undefined;
    if (typeof v !== 'string') {
      throw new InvalidRequestError(`${field} must be a string`);
    }
    return v.trim();
  }

  function optNullableStr(field: string): string | null | undefined {
    const v = obj[field];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'string') {
      throw new InvalidRequestError(`${field} must be a string or null`);
    }
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }

  function optSeverity(): 'low' | 'medium' | 'high' | undefined {
    const v = obj['alert_min_severity'];
    if (v === undefined) return undefined;
    if (v !== 'low' && v !== 'medium' && v !== 'high') {
      throw new InvalidRequestError(
        'alert_min_severity must be low|medium|high',
      );
    }
    return v;
  }

  function optBool(field: string): boolean | undefined {
    const v = obj[field];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') {
      throw new InvalidRequestError(`${field} must be a boolean`);
    }
    return v;
  }

  const sourceKind = optStr('source_kind') ?? 'filesystem';
  if (sourceKind !== 'filesystem') {
    throw new InvalidRequestError(
      `unsupported source_kind: ${sourceKind} (v1.9 only supports "filesystem")`,
    );
  }
  const cronExpr = partial
    ? optStr('cron_expression') ?? ''
    : reqStr('cron_expression');
  return {
    name: partial ? optStr('name') ?? '' : reqStr('name'),
    sourceKind,
    sourceRef: partial ? optStr('source_ref') ?? '' : reqStr('source_ref'),
    cronExpression: cronExpr,
    enabled: optBool('enabled'),
    notifyEmails: optNullableStr('notify_emails'),
    webhookUrl: optNullableStr('webhook_url'),
    webhookSecret: optNullableStr('webhook_secret'),
    alertMinSeverity: optSeverity(),
  };
}

function computeNextOrThrow(cronExpr: string): Date | null {
  if (cronExpr === '') return null;
  try {
    return nextRun(cronExpr);
  } catch (err) {
    if (err instanceof CronParseError) {
      throw new InvalidRequestError(`invalid cron_expression: ${err.message}`);
    }
    throw err;
  }
}

function toWire(r: ScheduledScanRecord) {
  return {
    id: r.id,
    user_id: r.userId,
    name: r.name,
    source_kind: r.sourceKind,
    source_ref: r.sourceRef,
    cron_expression: r.cronExpression,
    enabled: r.enabled,
    last_run_at: r.lastRunAt?.toISOString() ?? null,
    last_run_job_id: r.lastRunJobId,
    next_run_at: r.nextRunAt?.toISOString() ?? null,
    notify_emails: r.notifyEmails,
    webhook_url: r.webhookUrl,
    /** Secret is write-only — we never return it. */
    webhook_secret_set: r.webhookSecret !== null && r.webhookSecret !== '',
    alert_min_severity: r.alertMinSeverity,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function hasScanRole(
  user: NonNullable<Express.Request['user']>,
  min: 'viewer' | 'operator' | 'admin',
): boolean {
  if (user.isOrgAdmin) return true;
  const have = user.roles.scan;
  if (have === undefined) return false;
  const rank: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
  return (rank[have] ?? 0) >= rank[min]!;
}

function isOrgAdminOrScanAdmin(
  user: NonNullable<Express.Request['user']>,
): boolean {
  return user.isOrgAdmin || user.roles.scan === 'admin';
}

async function fetchOwned(
  store: ScheduledScanStore,
  id: string,
  user: NonNullable<Express.Request['user']>,
): Promise<ScheduledScanRecord> {
  let row: ScheduledScanRecord | null;
  try {
    row = await store.findById(id);
  } catch (err) {
    if (err instanceof ScheduledScanNotFoundError) {
      throw new NotFoundError('scheduled scan');
    }
    throw err;
  }
  if (row === null) throw new NotFoundError('scheduled scan');
  if (!isOrgAdminOrScanAdmin(user) && row.userId !== user.id) {
    throw new NotFoundError('scheduled scan');
  }
  return row;
}
