import { Router } from 'express';
import { registry } from '../metrics.js';

export function metricsRouter(): Router {
  const router: Router = Router();
  router.get('/metrics', (_req, res, next) => {
    void (async () => {
      try {
        res.setHeader('content-type', registry.contentType);
        res.send(await registry.metrics());
      } catch (err) {
        next(err);
      }
    })();
  });
  return router;
}
