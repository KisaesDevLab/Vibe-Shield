import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { httpLatency, httpRequests } from '../metrics.js';

/**
 * Minimal access log. Captures method, path, status, latency, request
 * size, and the correlation ID (via the pino mixin) — never the body
 * or any header value beyond Content-Length.
 *
 * Also drives the gateway's HTTP-level Prometheus counters/histograms
 * (Phase 19). Route normalization: we use req.route?.path when set
 * (parameterized — e.g. ``/v1/sessions/:id``) so per-id labels don't
 * blow up cardinality; otherwise fall back to req.path.
 */
export function accessLogMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    const contentLength = Number(req.header('content-length') ?? '0');
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const route =
        (req.route as { path?: string } | undefined)?.path ??
        normalizeRoute(req.path);
      logger.info(
        {
          method: req.method,
          path: req.path,
          status_code: res.statusCode,
          latency_ms: Number(elapsedMs.toFixed(2)),
          request_bytes: contentLength,
          tenant_id: req.auth?.tenantId,
          app_id: req.auth?.appId,
        },
        'request',
      );
      httpRequests.inc({
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      httpLatency.observe(
        { method: req.method, route },
        elapsedMs / 1000,
      );
    });
    next();
  };
}

/**
 * Collapse path-parameter values (UUIDs etc.) so Prometheus label
 * cardinality doesn't explode.
 */
function normalizeRoute(path: string): string {
  return path
    .replace(/\/[0-9a-f-]{36}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}
