/**
 * /v1/sessions — token-vault session lifecycle endpoints.
 *
 * Deferred from Phase 6; lands here with the gateway scaffold so that
 * the HTTP surface exists once Phase 8 wires the /v1/messages proxy.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  SessionExpiredError,
  type SessionManager,
} from '@kisaesdevlab/vibe-shield-schema';
import {
  AuthenticationError,
  InvalidRequestError,
  NotFoundError,
} from '../errors.js';

const createBody = z.object({
  user_id: z.string().min(1),
  policy_id: z.string().uuid().optional(),
  ttl_minutes: z.number().int().positive().max(24 * 60).optional(),
});

interface SessionsDeps {
  sessions: SessionManager;
  defaultTtlMinutes: number;
}

export function sessionsRouter(deps: SessionsDeps): Router {
  const router: Router = Router();

  router.post('/v1/sessions', (req, res, next) => {
    void (async () => {
      try {
        if (req.auth === undefined) {
          throw new AuthenticationError();
        }
        const parsed = createBody.safeParse(req.body);
        if (!parsed.success) {
          next(parsed.error);
          return;
        }
        const created = await deps.sessions.create({
          tenantId: req.auth.tenantId,
          appId: req.auth.appId,
          userId: parsed.data.user_id,
          ttlMinutes: parsed.data.ttl_minutes ?? deps.defaultTtlMinutes,
          ...(parsed.data.policy_id !== undefined
            ? { policyId: parsed.data.policy_id }
            : {}),
        });
        res.status(201).json({
          id: created.id,
          tenant_id: created.tenantId,
          app_id: created.appId,
          user_id: created.userId,
          policy_id: created.policyId,
          created_at: created.createdAt.toISOString(),
          expires_at: created.expiresAt.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/v1/sessions/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.auth === undefined) {
          throw new AuthenticationError();
        }
        const id = req.params['id'];
        if (id === undefined || !uuidRe.test(id)) {
          throw new InvalidRequestError('session id must be a UUID');
        }
        let session;
        try {
          session = await deps.sessions.get(id);
        } catch (err) {
          if (err instanceof SessionExpiredError) {
            throw new NotFoundError('session expired');
          }
          throw err;
        }
        if (session === null) {
          throw new NotFoundError('session not found');
        }
        if (session.tenantId !== req.auth.tenantId) {
          // Don't leak existence to other tenants — return 404, not 403.
          throw new NotFoundError('session not found');
        }
        res.json({
          id: session.id,
          tenant_id: session.tenantId,
          app_id: session.appId,
          user_id: session.userId,
          policy_id: session.policyId,
          created_at: session.createdAt.toISOString(),
          expires_at: session.expiresAt.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/sessions/:id', (req, res, next) => {
    void (async () => {
      try {
        if (req.auth === undefined) {
          throw new AuthenticationError();
        }
        const id = req.params['id'];
        if (id === undefined || !uuidRe.test(id)) {
          throw new InvalidRequestError('session id must be a UUID');
        }
        // Verify ownership before deletion; never leak the existence of
        // a session that belongs to a different tenant.
        let session;
        try {
          session = await deps.sessions.get(id);
        } catch {
          session = null;
        }
        if (session === null || session.tenantId !== req.auth.tenantId) {
          throw new NotFoundError('session not found');
        }
        await deps.sessions.delete(id);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
