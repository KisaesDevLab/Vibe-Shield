/**
 * /v1/messages — Anthropic Messages API shape.
 *
 * Phase 7 scope: validate the request against the Anthropic shape and
 * return 501 with an Anthropic-shaped envelope. The actual proxy,
 * including streaming, tool-use redaction, system-prompt scrubbing,
 * and Anthropic-key consumer-key block, ships in Phase 8.
 *
 * The validation step is real and exercised by tests — a malformed
 * request gets a 400 with a sanitized field list before the 501 fires.
 */

import { Router } from 'express';
import { NotImplementedError } from '../errors.js';
import { messagesRequest } from '../schemas/messages.js';

export function messagesRouter(): Router {
  const router: Router = Router();

  router.post('/v1/messages', (req, _res, next) => {
    const parsed = messagesRequest.safeParse(req.body);
    if (!parsed.success) {
      next(parsed.error);
      return;
    }
    // Auth has already attached req.auth via the guard chain; we don't
    // touch req.body further here — the actual proxy is Phase 8.
    next(
      new NotImplementedError(
        'POST /v1/messages: redaction proxy not yet implemented; ships in Phase 8',
      ),
    );
  });

  return router;
}
