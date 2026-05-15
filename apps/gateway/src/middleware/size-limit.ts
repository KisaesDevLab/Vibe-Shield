import type { NextFunction, Request, Response } from 'express';
import { InvalidRequestError } from '../errors.js';

/**
 * Rejects requests whose declared Content-Length exceeds the cap. Acts
 * before the JSON body parser so an oversized payload is rejected
 * without ever entering memory.
 */
export function sizeLimitMiddleware(maxBytes: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const declared = req.header('content-length');
    if (declared !== undefined) {
      const n = Number(declared);
      if (Number.isNaN(n)) {
        next(new InvalidRequestError('invalid content-length'));
        return;
      }
      if (n > maxBytes) {
        next(new InvalidRequestError(`request exceeds max_bytes=${maxBytes.toString()}`));
        return;
      }
    }
    next();
  };
}
