/**
 * Express app factory. Single composition point — tests construct an
 * app instance with mocked deps; the entry point in ``index.ts`` uses
 * real deps.
 */

import type Anthropic from '@anthropic-ai/sdk';
import express, { type Express } from 'express';
import type { Logger } from 'pino';
import type {
  ApiKeyStore,
  AuditLogger,
  Database,
  SessionManager,
  TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import type { AnthropicMessagesClient } from './anthropic/client.js';
import type { EngineClient } from './engine/client.js';
import { errorHandler } from './errors.js';
import { accessLogMiddleware } from './middleware/access-log.js';
import { apiKeyMiddleware } from './middleware/api-key.js';
import { correlationIdMiddleware } from './middleware/correlation-id.js';
import { sizeLimitMiddleware } from './middleware/size-limit.js';
import type { PolicyResolver } from './policy/resolver.js';
import type { RateLimiter } from './quota/rate-limiter.js';
import type { SpendTracker } from './quota/spend-cap.js';
import { healthRouter } from './routes/health.js';
import { materializeRouter } from './routes/materialize.js';
import { messagesRouter } from './routes/messages.js';
import { metricsRouter } from './routes/metrics.js';
import { openapiRouter } from './routes/openapi.js';
import { readyRouter } from './routes/ready.js';
import { sessionsRouter } from './routes/sessions.js';

export interface AppDeps {
  db: Database;
  apiKeys: ApiKeyStore;
  sessions: SessionManager;
  vault: TokenVault;
  engine: EngineClient;
  anthropic: AnthropicMessagesClient;
  /** Real Anthropic SDK instance — used by the streaming branch. */
  anthropicSdk?: Anthropic;
  logger: Logger;
  maxRequestBytes: number;
  sessionTtlMinutes: number;
  engineUrl?: string;
  rateLimiter?: RateLimiter;
  spendTracker?: SpendTracker;
  policies?: PolicyResolver;
  zdrEnabled?: boolean;
  audit?: AuditLogger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Order matters:
  //   1. Correlation ID lands before any other middleware so logs carry it.
  //   2. Access log subscribes to res:finish; no body capture.
  //   3. Size limit rejects oversized payloads before the JSON parser.
  //   4. JSON parser then bounds again at express level.
  //   5. Unauthenticated routes (/health, /ready, /openapi.json).
  //   6. API-key guard for everything beneath /v1/*.
  app.use(correlationIdMiddleware);
  app.use(accessLogMiddleware(deps.logger));
  app.use(sizeLimitMiddleware(deps.maxRequestBytes));
  app.use(express.json({ limit: deps.maxRequestBytes }));

  app.use(healthRouter());
  app.use(readyRouter({ db: deps.db, ...(deps.engineUrl !== undefined ? { engineUrl: deps.engineUrl } : {}) }));
  app.use(openapiRouter());
  app.use(metricsRouter());

  // Everything under /v1 requires a valid Vibe-issued API key.
  const v1 = express.Router();
  v1.use(apiKeyMiddleware(deps.apiKeys));
  v1.use(
    messagesRouter({
      engine: deps.engine,
      anthropic: deps.anthropic,
      vault: deps.vault,
      sessions: deps.sessions,
      apiKeys: deps.apiKeys,
      defaultSessionTtlMinutes: deps.sessionTtlMinutes,
      ...(deps.anthropicSdk !== undefined ? { anthropicSdk: deps.anthropicSdk } : {}),
      ...(deps.rateLimiter !== undefined ? { rateLimiter: deps.rateLimiter } : {}),
      ...(deps.spendTracker !== undefined ? { spendTracker: deps.spendTracker } : {}),
      ...(deps.policies !== undefined ? { policies: deps.policies } : {}),
      ...(deps.zdrEnabled !== undefined ? { zdrEnabled: deps.zdrEnabled } : {}),
      ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
    }),
  );
  v1.use(sessionsRouter({ sessions: deps.sessions, defaultTtlMinutes: deps.sessionTtlMinutes }));
  v1.use(
    materializeRouter({
      vault: deps.vault,
      sessions: deps.sessions,
      ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
      ...(deps.policies !== undefined ? { policies: deps.policies } : {}),
    }),
  );
  app.use(v1);

  app.use(errorHandler);
  return app;
}
