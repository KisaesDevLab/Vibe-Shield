/**
 * /v1/messages — Anthropic Messages API proxy.
 *
 * Phase 8 wires the full non-streaming proxy: redact → call Anthropic
 * → re-identify. Streaming + tool-use-streaming responses follow in
 * Phase 8b alongside Redis rate limiting and spend caps.
 */

import { Router } from 'express';
import type {
  ApiKeyStore,
  SessionManager,
  TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import type { AnthropicMessagesClient } from '../anthropic/client.js';
import type { EngineClient } from '../engine/client.js';
import { AuthenticationError, NotImplementedError } from '../errors.js';
import { getCorrelationId } from '../middleware/correlation-storage.js';
import { messagesRequest } from '../schemas/messages.js';
import { ProxyOrchestrator } from '../proxy/orchestrator.js';

export interface MessagesDeps {
  engine: EngineClient;
  anthropic: AnthropicMessagesClient;
  vault: TokenVault;
  sessions: SessionManager;
  apiKeys: ApiKeyStore;
  defaultSessionTtlMinutes: number;
}

export function messagesRouter(deps: MessagesDeps): Router {
  const router: Router = Router();
  const orchestrator = new ProxyOrchestrator({
    engine: deps.engine,
    anthropic: deps.anthropic,
    vault: deps.vault,
    sessions: deps.sessions,
    apiKeys: deps.apiKeys,
    defaultSessionTtlMinutes: deps.defaultSessionTtlMinutes,
  });

  router.post('/v1/messages', (req, res, next) => {
    void (async () => {
      try {
        const parsed = messagesRequest.safeParse(req.body);
        if (!parsed.success) {
          next(parsed.error);
          return;
        }
        if (req.auth === undefined) {
          throw new AuthenticationError();
        }
        if (parsed.data.stream === true) {
          // Phase 8b ships streaming. Today we'd have to buffer the
          // SSE stream through the re-identification layer; cleaner to
          // hold the line until that lands.
          throw new NotImplementedError(
            'stream=true: SSE proxy not yet implemented; ships in Phase 8b',
          );
        }
        const { response, sessionId } = await orchestrator.handle(
          parsed.data,
          req.auth,
          getCorrelationId(),
        );
        res.setHeader('vs-session-id', sessionId);
        res.json(response);
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
