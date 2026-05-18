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

import {
  UserExistsError,
  fingerprintOf,
  type ApiKeyStore,
  type ApplianceSecretStore,
  type AuditLogger,
  type RecognizerMissStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type { AnthropicClientHolder } from '../anthropic/holder.js';
import {
  AnthropicUnreachableError,
  ConsumerKeyError,
  probeAnthropicKey,
} from '../anthropic/probe.js';
import type { AnthropicKeyReprobe } from '../anthropic/reprobe.js';
import {
  AuthenticationError,
  ConflictError,
  EngineUnavailableError,
  InvalidRequestError,
  NotFoundError,
} from '../errors.js';
import type { PolicyResolver } from '../policy/resolver.js';

export interface AdminDeps {
  /**
   * The admin key the operator presents in X-Admin-Key. Loaded from
   * GATEWAY_ADMIN_KEY env var by the entry point.
   *
   * Phase 24 made this co-exist with the session-cookie path: admin
   * routes pass when EITHER the X-Admin-Key matches OR ``req.user``
   * has ``is_org_admin=true``. When both are undefined the router
   * refuses every request with 401.
   */
  adminKey?: string;
  apiKeys: ApiKeyStore;
  audit?: AuditLogger;
  recognizerMisses?: RecognizerMissStore;
  policies?: PolicyResolver;
  reprobe?: AnthropicKeyReprobe;
  /** Phase 23.5: holder of the live Anthropic client; admin can rotate. */
  anthropicHolder?: AnthropicClientHolder;
  /** Phase 23.5: appliance secret vault for the rotated key. */
  applianceSecrets?: ApplianceSecretStore;
  /** Phase 23.5: env-set bootstrap key for revert-to-env. */
  bootstrapApiKey?: string;
  /** Phase 23.5: probe override for tests. */
  probeFn?: typeof probeAnthropicKey;
  /** Phase 24: user store for the Users page + invite flow. */
  users?: import('@kisaesdevlab/vibe-shield-schema').UserStore;
  /** Phase 24: magic-link store for the invite flow. */
  magicLinks?: import('@kisaesdevlab/vibe-shield-schema').MagicLinkStore;
  /** Phase 24: mailer for the invite flow. */
  mailer?: import('../auth/mailer.js').Mailer;
  /** Phase 24: public URL for magic-link URL composition. */
  publicUrl?: string;
}

const issueBody = z.object({
  tenantId: z.string().min(1),
  appId: z.string().min(1).optional().default('default'),
  label: z.string().min(1),
});

const anthropicKeyBody = z.object({
  key: z.string().min(1, 'key is required'),
});

// Phase 24 — Users management

const moduleEnum = z.enum(['redact', 'scan', 'compliance']);
const roleEnum = z.enum(['viewer', 'operator', 'admin']);

const inviteBody = z.object({
  email: z.string().email().max(320),
  isOrgAdmin: z.boolean().optional().default(false),
  roles: z
    .record(moduleEnum, roleEnum)
    .optional()
    .default({}),
});

const setRoleBody = z.object({
  module: moduleEnum,
  role: roleEnum,
});

const setOrgAdminBody = z.object({
  isOrgAdmin: z.boolean(),
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

  // ---- Anthropic key management (Phase 23.5) -------------------
  //
  // Source-of-truth flow:
  //   1. Operator pastes a new commercial key in the SPA → PUT.
  //   2. Gateway probes Anthropic with the candidate key. Bad key →
  //      400; nothing is persisted.
  //   3. Good key → encrypted with the appliance KEK and persisted in
  //      vs_appliance_settings (singleton); the holder is reloaded
  //      atomically so the next /v1/messages uses the new key.
  //   4. Audit row written with fingerprint only — never the plaintext.
  //
  // GET returns source + fingerprint + last-set-at; never plaintext.
  // DELETE reverts to the env-set bootstrap key; refuses if env is also
  // unset (otherwise rotation would leave the gateway with no key).

  router.get('/v1/admin/anthropic/key', (req, res, next) => {
    void (async () => {
      try {
        const meta = deps.anthropicHolder?.getMeta() ?? {
          source: 'env' as const,
          setAt: null,
          fingerprint: null,
        };
        const bootstrapPresent = deps.bootstrapApiKey !== undefined;
        res.json({
          source: meta.source,
          fingerprint: meta.fingerprint,
          set_at: meta.setAt?.toISOString() ?? null,
          bootstrap_present: bootstrapPresent,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.put('/v1/admin/anthropic/key', (req, res, next) => {
    void (async () => {
      try {
        if (deps.anthropicHolder === undefined || deps.applianceSecrets === undefined) {
          throw new InvalidRequestError('Anthropic-key management not configured');
        }
        const parsed = anthropicKeyBody.safeParse(req.body);
        if (!parsed.success) {
          throw new InvalidRequestError(parsed.error.issues.map((i) => i.message).join('; '));
        }
        const candidate = parsed.data.key.trim();
        if (candidate.length === 0) {
          throw new InvalidRequestError(
            'key is required (whitespace-only payload rejected)',
          );
        }
        const probe = deps.probeFn ?? probeAnthropicKey;
        // Probe BEFORE persist. Bad keys must not reach the DB.
        try {
          await probe({ apiKey: candidate });
        } catch (err) {
          if (err instanceof ConsumerKeyError) {
            throw new InvalidRequestError(
              'Anthropic rejected the key. Only commercial API keys are accepted.',
            );
          }
          if (err instanceof AnthropicUnreachableError) {
            throw new EngineUnavailableError('Anthropic unreachable during probe');
          }
          throw err;
        }
        const { fingerprint } = await deps.applianceSecrets.setAnthropicKey(
          candidate,
          'admin',
        );
        deps.anthropicHolder.reload({
          apiKey: candidate,
          meta: { source: 'db', setAt: new Date(), fingerprint },
        });
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'anthropic_key_set',
              module: 'admin',
              payload: { fingerprint },
            })
            .catch(() => undefined);
        }
        res.json({ source: 'db', fingerprint, set_at: new Date().toISOString() });
      } catch (err) {
        next(err);
      }
    })();
  });

  // ---- Users + invites (Phase 24) ------------------------------

  router.get('/v1/admin/users', (req, res, next) => {
    void (async () => {
      try {
        if (deps.users === undefined) {
          throw new InvalidRequestError('user store not configured');
        }
        const rows = await deps.users.listAll();
        res.json(
          rows.map((u) => ({
            id: u.id,
            email: u.email,
            is_org_admin: u.isOrgAdmin,
            created_at: u.createdAt.toISOString(),
            last_login_at: u.lastLoginAt?.toISOString() ?? null,
            disabled_at: u.disabledAt?.toISOString() ?? null,
            roles: u.roles,
          })),
        );
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/v1/admin/users', (req, res, next) => {
    void (async () => {
      try {
        if (deps.users === undefined) {
          throw new InvalidRequestError('user store not configured');
        }
        const parsed = inviteBody.safeParse(req.body);
        if (!parsed.success) {
          throw new InvalidRequestError(
            parsed.error.issues.map((i) => i.message).join('; '),
          );
        }
        const email = parsed.data.email.trim().toLowerCase();
        if (email.length === 0) {
          throw new InvalidRequestError(
            'email is required (whitespace-only payload rejected)',
          );
        }
        // Create the user idempotently. If they already exist
        // (re-invite), just return the existing record. UserExistsError
        // is caught here only because a race between findByEmail and
        // create could let it through — surface as 409 Conflict.
        let user = await deps.users.findByEmail(email);
        if (user === null) {
          try {
            user = await deps.users.create({
              email,
              isOrgAdmin: parsed.data.isOrgAdmin,
            });
          } catch (e) {
            if (e instanceof UserExistsError) {
              throw new ConflictError(`user with email ${email} already exists`);
            }
            throw e;
          }
          if (deps.audit !== undefined) {
            await deps.audit
              .append({
                tenantId: 'appliance',
                eventType: 'user_created',
                module: 'identity',
                payload: {
                  user_id: user.id,
                  is_org_admin: parsed.data.isOrgAdmin,
                  email_domain: email.split('@')[1] ?? '?',
                },
              })
              .catch(() => undefined);
          }
        }
        // Apply roles after create.
        for (const [m, r] of Object.entries(parsed.data.roles)) {
          await deps.users.setRole(
            user.id,
            m as 'redact' | 'scan' | 'compliance',
            r as 'viewer' | 'operator' | 'admin',
          );
        }
        // Send invite email if mailer is configured.
        let invited = false;
        if (
          deps.mailer !== undefined &&
          deps.magicLinks !== undefined &&
          deps.publicUrl !== undefined
        ) {
          const { token, expiresAt } = await deps.magicLinks.issue(email, req.ip ?? null);
          const url = `${deps.publicUrl.replace(/\/$/, '')}/api/auth/consume?token=${encodeURIComponent(token)}`;
          await deps.mailer.sendMagicLink({ to: email, url, expiresAt });
          invited = true;
        }
        res.status(201).json({
          id: user.id,
          email: user.email,
          is_org_admin: user.isOrgAdmin,
          invited,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.put('/v1/admin/users/:id/roles', (req, res, next) => {
    void (async () => {
      try {
        if (deps.users === undefined) {
          throw new InvalidRequestError('user store not configured');
        }
        const parsed = setRoleBody.safeParse(req.body);
        if (!parsed.success) {
          throw new InvalidRequestError(
            parsed.error.issues.map((i) => i.message).join('; '),
          );
        }
        const id = req.params.id ?? '';
        const user = await deps.users.findById(id);
        if (user === null) throw new NotFoundError('user');
        const before = await deps.users.findByIdWithRoles(id);
        await deps.users.setRole(id, parsed.data.module, parsed.data.role);
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'user_role_changed',
              module: 'identity',
              payload: {
                user_id: id,
                module: parsed.data.module,
                from: before?.roles[parsed.data.module] ?? null,
                to: parsed.data.role,
              },
            })
            .catch(() => undefined);
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/admin/users/:id/roles/:module', (req, res, next) => {
    void (async () => {
      try {
        if (deps.users === undefined) {
          throw new InvalidRequestError('user store not configured');
        }
        const id = req.params.id ?? '';
        const m = req.params.module ?? '';
        const parsed = moduleEnum.safeParse(m);
        if (!parsed.success) {
          throw new InvalidRequestError('invalid module');
        }
        const before = await deps.users.findByIdWithRoles(id);
        await deps.users.revokeRole(id, parsed.data);
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'user_role_changed',
              module: 'identity',
              payload: {
                user_id: id,
                module: parsed.data,
                from: before?.roles[parsed.data] ?? null,
                to: null,
              },
            })
            .catch(() => undefined);
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.put('/v1/admin/users/:id/org-admin', (req, res, next) => {
    void (async () => {
      try {
        if (deps.users === undefined) {
          throw new InvalidRequestError('user store not configured');
        }
        const parsed = setOrgAdminBody.safeParse(req.body);
        if (!parsed.success) {
          throw new InvalidRequestError(
            parsed.error.issues.map((i) => i.message).join('; '),
          );
        }
        const id = req.params.id ?? '';
        const user = await deps.users.findById(id);
        if (user === null) throw new NotFoundError('user');
        await deps.users.setOrgAdmin(id, parsed.data.isOrgAdmin);
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'user_org_admin_changed',
              module: 'identity',
              payload: {
                user_id: id,
                from: user.isOrgAdmin,
                to: parsed.data.isOrgAdmin,
              },
            })
            .catch(() => undefined);
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/admin/users/:id', (req, res, next) => {
    void (async () => {
      try {
        if (deps.users === undefined) {
          throw new InvalidRequestError('user store not configured');
        }
        const id = req.params.id ?? '';
        const user = await deps.users.findById(id);
        if (user === null) throw new NotFoundError('user');
        // Self-disable would lock the operator out; refuse.
        if (req.user?.id === id) {
          throw new InvalidRequestError('cannot disable yourself');
        }
        await deps.users.disable(id);
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'user_disabled',
              module: 'identity',
              payload: {
                user_id: id,
                email_domain: user.email.split('@')[1] ?? '?',
              },
            })
            .catch(() => undefined);
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/v1/admin/anthropic/key', (req, res, next) => {
    void (async () => {
      try {
        if (deps.anthropicHolder === undefined || deps.applianceSecrets === undefined) {
          throw new InvalidRequestError('Anthropic-key management not configured');
        }
        if (deps.bootstrapApiKey === undefined || deps.bootstrapApiKey === '') {
          // Refuse: clearing the DB key would leave the gateway with
          // no Anthropic credentials at all. Operator must set
          // ANTHROPIC_API_KEY in env first.
          res
            .status(409)
            .json({
              error: {
                type: 'invalid_request_error',
                message:
                  'No env-set ANTHROPIC_API_KEY to fall back to; refusing to clear the admin-set key.',
              },
            });
          return;
        }
        const previousFingerprint = deps.anthropicHolder.getMeta().fingerprint;
        await deps.applianceSecrets.clearAnthropicKey('admin');
        deps.anthropicHolder.reload({
          apiKey: deps.bootstrapApiKey,
          meta: {
            source: 'env',
            setAt: null,
            fingerprint: fingerprintOf(deps.bootstrapApiKey),
          },
        });
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'anthropic_key_cleared',
              module: 'admin',
              payload: { previous_fingerprint: previousFingerprint },
            })
            .catch(() => undefined);
        }
        res.status(204).end();
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
    // Phase 24: session-backed org_admin bypasses the X-Admin-Key
    // header check. This is the path the SPA uses after magic-link
    // sign-in. The legacy header path stays for service operators
    // (curl scripts, bootstrap-before-first-user).
    if (req.user?.isOrgAdmin === true) {
      next();
      return;
    }
    if (configuredKey === undefined) {
      next(
        new AuthenticationError(
          'admin API disabled (no GATEWAY_ADMIN_KEY and no org_admin session)',
        ),
      );
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
