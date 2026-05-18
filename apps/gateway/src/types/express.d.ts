/**
 * Global Express type augmentation. ``req.auth`` is set by the tenant
 * api-key middleware and consumed by every /v1/messages route.
 * ``req.user`` is set by the session-auth middleware (Phase 24) and
 * consumed by /v1/admin/* and the auth routes.
 */

import type { Module, Role } from '@kisaesdevlab/vibe-shield-schema';
import type { AuthContext } from '../middleware/api-key.js';

export interface UserContext {
  id: string;
  email: string;
  isOrgAdmin: boolean;
  roles: Partial<Record<Module, Role>>;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      user?: UserContext;
    }
  }
}

export {};
