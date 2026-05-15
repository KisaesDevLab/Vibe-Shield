import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { correlationStorage } from './correlation-storage.js';

export const CORRELATION_HEADER = 'x-correlation-id';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const cid = incoming !== undefined && incoming !== '' ? incoming : randomUUID();
  res.setHeader(CORRELATION_HEADER, cid);
  correlationStorage.run(cid, () => {
    next();
  });
}
