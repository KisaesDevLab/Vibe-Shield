/**
 * /api/auth/* — Phase 24 magic-link auth.
 *
 * Endpoints:
 *   POST /api/auth/request-link   body { email } → 204, send link via SMTP
 *   GET  /api/auth/consume?token  → 302 to /, sets Set-Cookie: vs_session
 *   POST /api/auth/logout         → 204, clears cookie + revokes session
 *   GET  /api/auth/me             → { id, email, isOrgAdmin, roles } | 401
 *
 * Anti-enumeration: request-link returns 204 whether the email exists
 * or not. We only send the email when there's a real user. Operators
 * inviting new users go through POST /v1/admin/users instead (that
 * route requires org_admin).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { Logger } from 'pino';
import {
  MagicLinkInvalidError,
  type AuditLogger,
  type MagicLinkStore,
  type UserSessionStore,
  type UserStore,
} from '@kisaesdevlab/vibe-shield-schema';
import type { Mailer } from '../auth/mailer.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../auth/cookie.js';
import {
  AuthenticationError,
  InvalidRequestError,
  NotImplementedError,
} from '../errors.js';

export interface AuthDeps {
  users: UserStore;
  magicLinks: MagicLinkStore;
  sessions: UserSessionStore;
  audit?: AuditLogger;
  /** Mailer is optional — when SMTP is unset the routes 503 cleanly. */
  mailer?: Mailer;
  publicUrl?: string;
  /** True iff NODE_ENV=production — controls the cookie Secure flag. */
  secureCookies: boolean;
  logger: Logger;
}

const requestLinkBody = z.object({
  email: z.string().email().max(320),
});

export function authRouter(deps: AuthDeps): Router {
  const router: Router = Router();

  router.post('/api/auth/request-link', (req, res, next) => {
    void (async () => {
      try {
        const parsed = requestLinkBody.safeParse(req.body);
        if (!parsed.success) {
          throw new InvalidRequestError(
            parsed.error.issues.map((i) => i.message).join('; '),
          );
        }
        if (deps.mailer === undefined || deps.publicUrl === undefined) {
          throw new NotImplementedError(
            'magic-link sign-in is unavailable (SMTP_HOST / PUBLIC_URL not configured)',
          );
        }
        const email = parsed.data.email.trim().toLowerCase();
        const user = await deps.users.findByEmail(email);
        // Always respond 204 — never tell the caller whether the
        // address belongs to a user. Only actually send the email
        // when the user exists and is enabled.
        if (user !== null) {
          const ip = req.ip ?? null;
          const { token, expiresAt } = await deps.magicLinks.issue(email, ip);
          // Magic-link URL points DIRECTLY at the consume endpoint. The
          // gateway sets the session cookie and 302s to / so the SPA
          // loads already-authenticated. No client-side token handling.
          const url = `${deps.publicUrl.replace(/\/$/, '')}/api/auth/consume?token=${encodeURIComponent(token)}`;
          await deps.mailer.sendMagicLink({ to: email, url, expiresAt });
          if (deps.audit !== undefined) {
            await deps.audit
              .append({
                tenantId: 'appliance',
                eventType: 'request',
                module: 'identity',
                payload: {
                  action: 'magic_link_requested',
                  user_id: user.id,
                  email_domain: email.split('@')[1] ?? '?',
                },
              })
              .catch(() => undefined);
          }
        } else {
          deps.logger.info(
            { email_domain: email.split('@')[1] ?? '?' },
            'magic link requested for unknown email (no-op)',
          );
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/api/auth/consume', (req, res, next) => {
    void (async () => {
      try {
        const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
        if (token === '') {
          throw new InvalidRequestError('missing token');
        }
        let email: string;
        try {
          const consumed = await deps.magicLinks.consume(token);
          email = consumed.email;
        } catch (err) {
          if (err instanceof MagicLinkInvalidError) {
            throw new AuthenticationError('magic link invalid or already used');
          }
          throw err;
        }
        const user = await deps.users.findByEmail(email);
        if (user === null) {
          // The user was disabled between issue and consume. Refuse.
          throw new AuthenticationError('account no longer active');
        }
        const userAgent = req.header('user-agent') ?? null;
        const { token: sessionToken, expiresAt } = await deps.sessions.issue(
          user.id,
          userAgent,
        );
        await deps.users.markLogin(user.id);
        setSessionCookie(res, sessionToken, {
          secure: deps.secureCookies,
          expires: expiresAt,
        });
        if (deps.audit !== undefined) {
          await deps.audit
            .append({
              tenantId: 'appliance',
              eventType: 'session_create',
              module: 'identity',
              payload: { action: 'magic_link_consumed', user_id: user.id },
            })
            .catch(() => undefined);
        }
        // Redirect to the admin SPA root. The SPA will hit /api/auth/me
        // on load and render the authenticated UI.
        res.redirect(302, '/');
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/api/auth/logout', (req, res, next) => {
    void (async () => {
      try {
        const token = readSessionCookie(req);
        if (token !== undefined) {
          await deps.sessions.revoke(token);
          if (deps.audit !== undefined && req.user !== undefined) {
            await deps.audit
              .append({
                tenantId: 'appliance',
                eventType: 'session_purge',
                module: 'identity',
                payload: { action: 'logout', user_id: req.user.id },
              })
              .catch(() => undefined);
          }
        }
        clearSessionCookie(res, deps.secureCookies);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/api/auth/me', (req, res, next) => {
    void (async () => {
      try {
        if (req.user === undefined) {
          throw new AuthenticationError('not signed in');
        }
        const hydrated = await deps.users.findByIdWithRoles(req.user.id);
        if (hydrated === null) {
          throw new AuthenticationError('account no longer active');
        }
        res.json({
          id: hydrated.id,
          email: hydrated.email,
          is_org_admin: hydrated.isOrgAdmin,
          roles: hydrated.roles,
          mailer_configured: deps.mailer !== undefined,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

export { SESSION_COOKIE_NAME };
