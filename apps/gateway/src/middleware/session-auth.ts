/**
 * Session-auth middleware — Phase 24.
 *
 * Reads the vs_session cookie, validates it against the session store,
 * hydrates ``req.user`` with the resolved user + role map. Missing or
 * invalid cookies do not 401 here — they simply leave ``req.user``
 * unset and let the route's requires() middleware decide. That lets
 * unauthenticated callers still hit /api/auth/request-link and the
 * legacy X-Admin-Key path.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  SessionInvalidError,
  type UserSessionStore,
  type UserStore,
} from '@kisaesdevlab/vibe-shield-schema';
import { readSessionCookie } from '../auth/cookie.js';

export interface SessionAuthDeps {
  sessions: UserSessionStore;
  users: UserStore;
}

export function sessionAuthMiddleware(
  deps: SessionAuthDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    const token = readSessionCookie(req);
    if (token === undefined) {
      next();
      return;
    }
    void (async () => {
      try {
        const resolved = await deps.sessions.validate(token);
        const hydrated = await deps.users.findByIdWithRoles(resolved.userId);
        if (hydrated === null || hydrated.disabledAt !== null) {
          // User vanished or got disabled — treat as unauthenticated.
          next();
          return;
        }
        req.user = {
          id: hydrated.id,
          email: hydrated.email,
          isOrgAdmin: hydrated.isOrgAdmin,
          roles: hydrated.roles,
        };
        next();
      } catch (err) {
        if (err instanceof SessionInvalidError) {
          next();
          return;
        }
        next(err);
      }
    })();
  };
}
