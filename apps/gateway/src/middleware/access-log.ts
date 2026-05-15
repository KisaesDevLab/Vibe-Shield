import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

/**
 * Minimal access log. Captures method, path, status, latency, request
 * size, and the correlation ID (via the pino mixin) — never the body
 * or any header value beyond Content-Length.
 */
export function accessLogMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    const contentLength = Number(req.header('content-length') ?? '0');
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
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
    });
    next();
  };
}
