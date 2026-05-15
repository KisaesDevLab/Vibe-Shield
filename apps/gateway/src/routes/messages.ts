/**
 * /v1/messages — Anthropic Messages API proxy.
 *
 * Phase 8 (part 1): non-streaming proxy.
 * Phase 8b (this file's stream branch): SSE streaming with on-the-fly
 * re-identification, retry/backoff on 5xx and 429, per-tenant rate
 * limit + monthly spend cap.
 */

import type Anthropic from '@anthropic-ai/sdk';
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
import type { PolicyResolver } from '../policy/resolver.js';
import { ProxyOrchestrator } from '../proxy/orchestrator.js';
import { streamProxy } from '../proxy/streaming.js';
import type { RateLimiter } from '../quota/rate-limiter.js';
import type { SpendTracker } from '../quota/spend-cap.js';

export interface MessagesDeps {
  engine: EngineClient;
  anthropic: AnthropicMessagesClient;
  /** Concrete Anthropic SDK instance for streaming (typed methods). */
  anthropicSdk?: Anthropic;
  vault: TokenVault;
  sessions: SessionManager;
  apiKeys: ApiKeyStore;
  defaultSessionTtlMinutes: number;
  rateLimiter?: RateLimiter;
  spendTracker?: SpendTracker;
  policies?: PolicyResolver;
  zdrEnabled?: boolean;
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
    ...(deps.rateLimiter !== undefined ? { rateLimiter: deps.rateLimiter } : {}),
    ...(deps.spendTracker !== undefined ? { spendTracker: deps.spendTracker } : {}),
    ...(deps.policies !== undefined ? { policies: deps.policies } : {}),
    ...(deps.zdrEnabled !== undefined ? { zdrEnabled: deps.zdrEnabled } : {}),
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
          if (deps.anthropicSdk === undefined) {
            throw new NotImplementedError('streaming not configured for this deployment');
          }
          await orchestrator.checkQuotas(req.auth);
          const sessionId = await orchestrator.acquireSession(parsed.data, req.auth);
          const { params } = await orchestrator.redactForUpstream(
            parsed.data,
            sessionId,
            getCorrelationId(),
          );
          const streamingParams = {
            ...params,
            stream: true,
          } as unknown as Anthropic.MessageCreateParamsStreaming;
          res.setHeader('vs-session-id', sessionId);
          await streamProxy(res, streamingParams, {
            anthropic: deps.anthropicSdk,
            vault: deps.vault,
            sessionId,
          });
          return;
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
