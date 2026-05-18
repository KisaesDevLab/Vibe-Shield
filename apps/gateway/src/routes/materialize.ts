/**
 * POST /v1/sessions/:id/materialize — addendum 16.5.6.
 *
 * The Converter calls this exactly once per output file. It sends
 * structured JSON containing tokens; we walk the JSON, replace tokens
 * with cleartext via the vault, and return the materialized structure.
 * The audit log records a 'materialize' event with a hash of the
 * output (so peer review can prove which materialize event
 * corresponds to which downloaded file) and the tenant + session.
 *
 * Materialize is the *only* path that produces cleartext for the
 * cpa-converter-output policy. The /v1/messages response under that
 * policy returns tokens; the materialize endpoint is rate-limited and
 * audited as a separate event type.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  type AuditLogger,
  type SessionManager,
  type TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import {
  AuthenticationError,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
} from '../errors.js';
import { materializeEvents } from '../metrics.js';
import { CONVERTER_OUTPUT } from '../policy/built-in.js';
import type { PolicyResolver } from '../policy/resolver.js';

const materializeBody = z.object({
  /** Arbitrary JSON; tokens within it are resolved. */
  payload: z.unknown(),
  /** Optional caller-supplied output filename (recorded in audit). */
  output_filename: z.string().min(1).max(255).optional(),
});

const TOKEN_RE = /<([A-Z][A-Z_]*?)_(\d+)>/g;

export interface MaterializeDeps {
  vault: TokenVault;
  sessions: SessionManager;
  audit?: AuditLogger;
  policies?: PolicyResolver;
}

export function materializeRouter(deps: MaterializeDeps): Router {
  const router: Router = Router();

  router.post('/v1/sessions/:id/materialize', (req, res, next) => {
    void (async () => {
      try {
        if (req.auth === undefined) {
          throw new AuthenticationError();
        }
        const id = req.params['id'];
        if (id === undefined || !uuidRe.test(id)) {
          throw new InvalidRequestError('session id must be a UUID');
        }
        const parsed = materializeBody.safeParse(req.body);
        if (!parsed.success) {
          next(parsed.error);
          return;
        }
        // Verify session ownership.
        let session;
        try {
          session = await deps.sessions.get(id);
        } catch {
          throw new NotFoundError('session not found');
        }
        if (session === null || session.tenantId !== req.auth.tenantId) {
          throw new NotFoundError('session not found');
        }

        // Materialize is gated by the active policy. Only the
        // cpa-converter-output policy permits it today; any other
        // policy refuses. (Built-in policies enforce this — the
        // resolver picks cpa-converter-output for app_id='converter';
        // calls from app_id='mybooks' get strict bookkeeping and 403.)
        if (deps.policies !== undefined) {
          const policy = await deps.policies.resolve({
            tenantId: req.auth.tenantId,
            appId: req.auth.appId,
          });
          if (policy.name !== CONVERTER_OUTPUT.name) {
            throw new PermissionError(
              `materialize requires policy "${CONVERTER_OUTPUT.name}"; current policy is "${policy.name}"`,
            );
          }
        }

        // Walk the payload, resolve tokens.
        const tokens = new Set<string>();
        collectTokens(parsed.data.payload, tokens);
        const resolved = new Map<string, string>();
        await Promise.all(
          Array.from(tokens).map(async (token) => {
            const cleartext = await deps.vault.resolve(id, token);
            if (cleartext !== null) {
              resolved.set(token, cleartext);
            }
          }),
        );
        const materialized = walkAndReplace(parsed.data.payload, (s) =>
          s.replace(TOKEN_RE, (m) => resolved.get(m) ?? m),
        );

        // Hash the output for audit. The hash is what proves later
        // which downloaded file came from which materialize event.
        const outputHash = createHash('sha256')
          .update(JSON.stringify(materialized))
          .digest('hex');

        if (deps.audit !== undefined) {
          await deps.audit.append({
            tenantId: req.auth.tenantId,
            sessionId: id,
            eventType: 'materialize',
            module: 'egress',
            payload: {
              app_id: req.auth.appId,
              output_filename: parsed.data.output_filename ?? null,
              output_sha256: outputHash,
              token_count: tokens.size,
              resolved_count: resolved.size,
            },
          });
        }

        materializeEvents.inc({
          tenant_id: req.auth.tenantId,
          app_id: req.auth.appId,
        });
        res.json({
          materialized,
          output_sha256: outputHash,
          tokens_resolved: resolved.size,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

function collectTokens(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN_RE)) into.add(m[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTokens(item, into);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) collectTokens(v, into);
  }
}

function walkAndReplace(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => walkAndReplace(item, fn));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkAndReplace(v, fn);
    return out;
  }
  return value;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
