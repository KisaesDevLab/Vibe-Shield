/**
 * Anthropic-shaped error envelope + domain exceptions.
 *
 * Anthropic's API returns errors as:
 *   {
 *     "type": "error",
 *     "error": { "type": "<kind>", "message": "<text>" }
 *   }
 *
 * We mirror that exactly so existing ``@anthropic-ai/sdk`` consumers
 * don't have to handle a second error shape. Hard rule #1 applies:
 * ``message`` carries only safe text — never request bodies, never
 * exception messages built from user input.
 */

import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { getCorrelationId } from './logging.js';

export type AnthropicErrorKind =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';

export interface AnthropicError {
  type: 'error';
  error: { type: AnthropicErrorKind; message: string };
  correlation_id: string | null;
}

function envelope(kind: AnthropicErrorKind, message: string): AnthropicError {
  return {
    type: 'error',
    error: { type: kind, message },
    correlation_id: getCorrelationId() ?? null,
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly kind: AnthropicErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toEnvelope(): AnthropicError {
    return envelope(this.kind, this.message);
  }
}

export class AuthenticationError extends HttpError {
  constructor(message: string = 'Authentication failed') {
    super(401, 'authentication_error', message);
    this.name = 'AuthenticationError';
  }
}

export class PermissionError extends HttpError {
  constructor(message: string = 'Permission denied') {
    super(403, 'permission_error', message);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string = 'Not found') {
    super(404, 'not_found_error', message);
    this.name = 'NotFoundError';
  }
}

export class InvalidRequestError extends HttpError {
  constructor(message: string = 'Invalid request') {
    super(400, 'invalid_request_error', message);
    this.name = 'InvalidRequestError';
  }
}

export class NotImplementedError extends HttpError {
  constructor(message: string = 'Not implemented') {
    super(501, 'api_error', message);
    this.name = 'NotImplementedError';
  }
}

export class EngineUnavailableError extends HttpError {
  constructor(message: string = 'Engine unavailable') {
    super(503, 'api_error', message);
    this.name = 'EngineUnavailableError';
  }
}

/**
 * Marker interface for HttpError subclasses that want a Retry-After
 * response header set. v1.1.2 §round-2 Defect #6: RFC 6585 says 429
 * SHOULD include Retry-After; without it clients can't implement
 * principled backoff. RateLimitHttpError implements this; the error
 * handler reads ``retryAfterSeconds`` and sets the header.
 */
export interface HasRetryAfter {
  readonly retryAfterSeconds: number;
}

function hasRetryAfter(err: unknown): err is HttpError & HasRetryAfter {
  return (
    err instanceof HttpError &&
    typeof (err as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
  );
}

/**
 * Express error-handling middleware.
 *
 * - Known ``HttpError`` subclasses → their declared status + envelope.
 * - ``ZodError`` → 400 with field paths only (never the offending value;
 *   Zod's ``input`` mirror of the offending field would leak PII).
 * - Anything else → 500 with a generic message. The actual exception is
 *   logged via ``error_class`` only.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const logger = (req as { log?: { error: (o: object, msg: string) => void } }).log;
  if (err instanceof HttpError) {
    if (logger !== undefined) {
      logger.error({ error_class: err.name, status: err.status }, 'http_error');
    }
    if (hasRetryAfter(err)) {
      // RFC 6585: Retry-After value is delta-seconds (integer).
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterSeconds))));
    }
    res.status(err.status).json(err.toEnvelope());
    return;
  }
  if (err instanceof ZodError) {
    const fields = err.issues
      .map((issue) => issue.path.join('.'))
      .filter((p) => p !== '');
    if (logger !== undefined) {
      logger.error({ error_class: 'ZodError', fields }, 'validation_error');
    }
    res
      .status(400)
      .json(envelope('invalid_request_error', `validation failed: ${fields.join(', ')}`));
    return;
  }
  // Express body-parser raises SyntaxError on malformed JSON with
  // .type === 'entity.parse.failed' (and status 400). Without an
  // explicit branch these fall through to the generic 500/api_error,
  // which is wrong: malformed JSON is a client error, not a server
  // failure. Surface as 400/invalid_request_error.
  if (
    err instanceof SyntaxError &&
    typeof (err as unknown as { type?: unknown }).type === 'string' &&
    (err as unknown as { type: string }).type === 'entity.parse.failed'
  ) {
    if (logger !== undefined) {
      logger.error({ error_class: 'SyntaxError' }, 'body_parse_error');
    }
    res.status(400).json(envelope('invalid_request_error', 'malformed JSON body'));
    return;
  }
  if (logger !== undefined) {
    logger.error(
      { error_class: err instanceof Error ? err.name : 'Unknown' },
      'internal_error',
    );
  }
  res.status(500).json(envelope('api_error', 'Internal server error'));
};
