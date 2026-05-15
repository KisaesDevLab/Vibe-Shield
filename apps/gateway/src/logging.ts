/**
 * Structured logger.
 *
 * Hard rule #1: cleartext PII (request/response bodies, redacted text,
 * token maps) never appears in a log record. Pino's default serializers
 * are fine for our metadata, but we use a custom ``serializers`` list so
 * request bodies are not auto-captured by pino-http's default request
 * serializer.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import { getCorrelationId } from './middleware/correlation-storage.js';

export { getCorrelationId };

function buildLoggerOptions(level: string): LoggerOptions {
  // Build the options object conditionally rather than setting
  // ``transport: undefined`` (clashes with exactOptionalPropertyTypes).
  const opts: LoggerOptions = {
    level,
    base: { service: 'vibe-shield-gateway' },
    mixin() {
      const cid = getCorrelationId();
      return cid !== undefined ? { correlation_id: cid } : {};
    },
    serializers: {
      // Only safe metadata. NEVER include body, query, or any header
      // value beyond an explicit allowlist.
      req(req: { method: string; url: string }) {
        return { method: req.method, url: req.url };
      },
      res(res: { statusCode: number }) {
        return { status_code: res.statusCode };
      },
    },
  };
  if (process.env['NODE_ENV'] === 'development') {
    opts.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  return opts;
}

export function createLogger(level: string = 'info'): Logger {
  return pino(buildLoggerOptions(level));
}
