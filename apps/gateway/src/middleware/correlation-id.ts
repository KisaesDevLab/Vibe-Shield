import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { correlationStorage } from './correlation-storage.js';

export const CORRELATION_HEADER = 'x-correlation-id';

// v1.1.3 §review (S5): an attacker-supplied x-correlation-id is logged
// + echoed in response headers. Without sanitization, a CRLF
// (`abc\r\nINFO ...`) could forge log lines or smuggle a second
// response header. Accept only safe characters and bound the length;
// generate a fresh UUID on any rejection.
//
// The shape (UUID or arbitrary ASCII) doesn't matter for tracing —
// the value just needs to be a single line. Allow URL-safe characters
// + hyphens + colons, cap at 128 chars. That fits w3c trace-context
// IDs, our own UUIDs, and most observability vendor formats.
const SAFE_CID = /^[A-Za-z0-9_:.-]{1,128}$/;

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const cid =
    incoming !== undefined && SAFE_CID.test(incoming) ? incoming : randomUUID();
  res.setHeader(CORRELATION_HEADER, cid);
  correlationStorage.run(cid, () => {
    next();
  });
}
