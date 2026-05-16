/**
 * /v1/admin/* — admin REST API for the Phase 13 minimal admin UI.
 *
 * Auth: a separate admin key (X-Admin-Key header) gated by env var
 * ``GATEWAY_ADMIN_KEY``. Constant-time compare. NOT the same as the
 * tenant API keys; admin key is for the operator running the appliance.
 *
 * Hard rule posture:
 *   - All cleartext PII filtered upstream; admin endpoints return
 *     hashes / IDs / metadata only.
 *   - issueApiKey returns the cleartext key ONCE; never persisted in
 *     logs, never re-fetchable.
 *   - revokeApiKey is idempotent.
 *   - reprobe never crashes the gateway.
 *
 * Per .shield-build/open-decisions.md::D5 the v1.1 admin scope is
 * minimal: API key management, audit log browser, recognizer-miss
 * inspector, Anthropic key probe, policies list. Policy editing /
 * tenant management defer to v1.2.
 */

import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type {
  ApiKeyStore,
  AuditLogger,
  RecognizerMissStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type { AnthropicKeyReprobe } from '../anthropic/reprobe.js';
import { AuthenticationError, InvalidRequestError, NotFoundError } from '../errors.js';
import type { PolicyResolver } from '../policy/resolver.js';

export interface AdminDeps {
  /**
   * The admin key the operator presents in X-Admin-Key. Loaded from
   * GATEWAY_ADMIN_KEY env var by the entry point. If undefined, the
   * router refuses every request with 401 (admin disabled).
   */
  adminKey?: string;
  apiKeys: ApiKeyStore;
  audit?: AuditLogger;
  recognizerMisses?: RecognizerMissStore;
  policies?: PolicyResolver;
  reprobe?: AnthropicKeyReprobe;
}

const issueBody = z.object({
  tenantId: z.string().min(1),
  appId: z.string().min(1).optional().default('default'),
  label: z.string().min(1),
});

export function adminRouter(deps: AdminDeps): Router {
  const router: Router = Router();

  router.use('/v1/admin', adminAuthMiddleware(deps.adminKey));

  // ---- API key management --------------------------------------

  router.get('/v1/admin/api-keys', (req, res, next) => {
    void (async () => {
      try {
        const rows = await deps.apiKeys.list();
        res.json(
          rows.map((r) => ({
            id: r.id,
            tenant_id: r.tenantId,
            app_id: r.appId,
            label: r.label,
            created_at: r.createdAt,
            last_used_at: r.lastUsedAt,
            revoked_at: r.revokedAt,
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/v1/admin/api-keys', (req, res, next) => {
    void (async () => {
      try {
        const parsed = issueBody.safeParse(req.body);
        if (!parsed.success) {
          throw new InvalidRequestError(parsed.error.issues.map((i) => i.message).join('; '));
        }
        const issued = await deps.apiKeys.issue({
          tenantId: parsed.data.tenantId,
          appId: parsed.data.appId,
          name: parsed.data.label,
        });
        // Cleartext key returned ONCE in the response; never logged.
        res.status(201).json({
          id: issued.record.keyHash.toString('hex'),
          key: issued.key,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/admin/api-keys/:id', (req, res, next) => {
    void (async () => {
      try {
        const id = req.params.id ?? '';
        const ok = await deps.apiKeys.revokeByHashHex(id);
        if (!ok) throw new NotFoundError('api key');
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Audit log browser ---------------------------------------

  router.get('/v1/admin/audit', (req, res, next) => {
    void (async () => {
      try {
        if (deps.audit === undefined) {
          throw new InvalidRequestError('audit logger not configured');
        }
        const tenantId = typeof req.query['tenant_id'] === 'string' ? req.query['tenant_id'] : undefined;
        const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined;
        const opts: { tenantId?: string; limit?: number } = {};
        if (tenantId !== undefined) opts.tenantId = tenantId;
        if (limitRaw !== undefined && Number.isFinite(limitRaw)) opts.limit = limitRaw;
        const rows = await deps.audit.listRecent(opts);
        res.json(
          rows.map((r) => ({
            id: r.id,
            tenant_id: r.tenantId,
            session_id: r.sessionId,
            event_type: r.eventType,
            payload_hash: r.payloadHash,
            created_at: r.createdAt,
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Recognizer misses ---------------------------------------

  router.get('/v1/admin/recognizer-misses', (req, res, next) => {
    void (async () => {
      try {
        if (deps.recognizerMisses === undefined) {
          throw new InvalidRequestError('recognizer-miss store not configured');
        }
        const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined;
        const opts: { limit?: number } = {};
        if (limitRaw !== undefined && Number.isFinite(limitRaw)) opts.limit = limitRaw;
        const rows = await deps.recognizerMisses.listRecent(opts);
        res.json(
          rows.map((r) => ({
            id: r.id,
            pattern: r.pattern,
            sample_hash: r.sampleHash,
            severity: r.severity,
            created_at: r.createdAt,
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Anthropic key re-probe ----------------------------------

  router.post('/v1/admin/anthropic/probe', (req, res, next) => {
    void (async () => {
      try {
        if (deps.reprobe === undefined) {
          throw new InvalidRequestError('reprobe not configured');
        }
        const result = await deps.reprobe.runOnce();
        res.json(result);
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Policies (read-only list) -------------------------------

  router.get('/v1/admin/policies', (req, res, next) => {
    void (async () => {
      try {
        if (deps.policies === undefined) {
          throw new InvalidRequestError('policy resolver not configured');
        }
        const all = deps.policies.list();
        res.json(
          all.map((p) => ({
            id: p.name,
            name: p.name,
            // Per-policy version not surfaced through PolicyResolver in
            // v1.1; the underlying vs_policies row tracks it. UI shows 1.
            version: 1,
            zdr_required: p.zdr_required,
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

function adminAuthMiddleware(
  configuredKey: string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    if (configuredKey === undefined) {
      next(new AuthenticationError('admin API disabled (GATEWAY_ADMIN_KEY not configured)'));
      return;
    }
    const presented = req.header('x-admin-key');
    if (presented === undefined) {
      next(new AuthenticationError('missing X-Admin-Key header'));
      return;
    }
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(configuredKey, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      next(new AuthenticationError('invalid admin key'));
      return;
    }
    next();
  };
}
