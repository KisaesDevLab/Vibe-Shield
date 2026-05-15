import { Router } from 'express';
import type { Database } from '@kisaesdevlab/vibe-shield-schema';
import { sql } from 'drizzle-orm';

interface ReadyDeps {
  db: Database;
  /** Optional engine probe; Phase 8 will wire it. */
  engineUrl?: string;
}

export function readyRouter(deps: ReadyDeps): Router {
  const router: Router = Router();
  router.get('/ready', async (_req, res, next) => {
    try {
      // Cheap round-trip to the DB to confirm pool / network / auth.
      await deps.db.execute(sql`SELECT 1`);
      res.json({ status: 'ready', database: 'ok' });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
