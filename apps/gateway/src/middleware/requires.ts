/**
 * requires(module, minRole) — Phase 24 per-module RBAC.
 *
 * Refuses unless ``req.user`` is set AND either:
 *   - is_org_admin is true, OR
 *   - the user has a role >= ``minRole`` on ``module``.
 *
 * Use this as a route-level guard on Module 2 (Scan) and Module 3
 * (Compliance) endpoints once they exist. For now the admin routes use
 * ``requiresOrgAdmin`` (below) or accept the legacy X-Admin-Key path.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  type Module,
  type Role,
  roleSatisfies,
} from '@kisaesdevlab/vibe-shield-schema';
import { AuthenticationError, PermissionError } from '../errors.js';

export function requires(
  module: Module,
  minRole: Role,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    if (req.user === undefined) {
      next(new AuthenticationError('sign-in required'));
      return;
    }
    if (req.user.isOrgAdmin) {
      next();
      return;
    }
    const have = req.user.roles[module];
    if (have === undefined || !roleSatisfies(have, minRole)) {
      next(
        new PermissionError(
          `insufficient role: requires ${minRole}+ on ${module}`,
        ),
      );
      return;
    }
    next();
  };
}

/** Convenience: org_admin only. */
export function requiresOrgAdmin(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req, _res, next) => {
    if (req.user === undefined) {
      next(new AuthenticationError('sign-in required'));
      return;
    }
    if (!req.user.isOrgAdmin) {
      next(new PermissionError('org_admin required'));
      return;
    }
    next();
  };
}
