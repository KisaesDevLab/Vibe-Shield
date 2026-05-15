/**
 * Global Express type augmentation. ``req.auth`` is set by the
 * api-key middleware and consumed by every protected route.
 */

import type { AuthContext } from '../middleware/api-key.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
