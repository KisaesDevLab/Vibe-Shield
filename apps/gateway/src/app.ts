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
  ApplianceSecretStore,
  AuditLogger,
  Database,
  RecognizerMissStore,
  SessionManager,
  TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import type { AnthropicMessagesClient } from './anthropic/client.js';
import type { AnthropicClientHolder } from './anthropic/holder.js';
import type { probeAnthropicKey } from './anthropic/probe.js';
import type { AnthropicKeyReprobe } from './anthropic/reprobe.js';
import type { EngineClient } from './engine/client.js';
import { errorHandler } from './errors.js';
import { accessLogMiddleware } from './middleware/access-log.js';
import { apiKeyMiddleware } from './middleware/api-key.js';
import { correlationIdMiddleware } from './middleware/correlation-id.js';
import { sizeLimitMiddleware } from './middleware/size-limit.js';
import type { PolicyResolver } from './policy/resolver.js';
import type { RateLimiter } from './quota/rate-limiter.js';
import type { SpendTracker } from './quota/spend-cap.js';
import { adminRouter } from './routes/admin.js';
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
  /**
   * Phase 23.5: prefer ``anthropicHolder`` for rotation-aware deployments.
   * Tests can still pass a static ``anthropic`` (and optional
   * ``anthropicSdk``) — when no holder is supplied, ``createApp`` wraps
   * the static clients in degenerate accessors that always return them.
   */
  anthropicHolder?: AnthropicClientHolder;
  anthropic?: AnthropicMessagesClient;
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
  recognizerMisses?: RecognizerMissStore;
  /** Admin API key (X-Admin-Key). When undefined, admin routes refuse all requests. */
  adminKey?: string;
  /** Reprobe handle for the admin "probe now" endpoint. */
  reprobe?: AnthropicKeyReprobe;
  /** Appliance settings vault — gates Phase 23.5 admin /v1/admin/anthropic/key. */
  applianceSecrets?: ApplianceSecretStore;
  /** Env-set ANTHROPIC_API_KEY captured at boot. Used by the admin
   *  DELETE /v1/admin/anthropic/key route to revert to the env key. */
  bootstrapApiKey?: string;
  /** Phase 23.5 probe override for tests. */
  probeFn?: typeof probeAnthropicKey;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Phase 23.5: routes consume Anthropic clients through accessors so
  // an admin key-rotation takes effect on the next request. When a
  // holder is supplied, the accessors read from it live; otherwise the
  // legacy static clients are returned (kept for tests).
  const staticAnthropic = deps.anthropic;
  const staticAnthropicSdk = deps.anthropicSdk;
  const getAnthropic: () => AnthropicMessagesClient =
    deps.anthropicHolder !== undefined
      ? () => deps.anthropicHolder!.getClient()
      : staticAnthropic !== undefined
        ? () => staticAnthropic
        : () => {
            throw new Error('Anthropic client not configured');
          };
  const getAnthropicSdk: (() => Anthropic) | undefined =
    deps.anthropicHolder !== undefined
      ? () => deps.anthropicHolder!.getSdk()
      : staticAnthropicSdk !== undefined
        ? () => staticAnthropicSdk
        : undefined;

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

  // Admin routes must mount BEFORE the v1 tenant-key router because
  // both share the /v1 prefix. Express matches routes in registration
  // order — without this, requests to /v1/admin/* hit the tenant
  // apiKeyMiddleware first and 401 on the missing Bearer header
  // before ever reaching the admin router's X-Admin-Key check.
  app.use(
    adminRouter({
      apiKeys: deps.apiKeys,
      ...(deps.adminKey !== undefined ? { adminKey: deps.adminKey } : {}),
      ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
      ...(deps.recognizerMisses !== undefined ? { recognizerMisses: deps.recognizerMisses } : {}),
      ...(deps.policies !== undefined ? { policies: deps.policies } : {}),
      ...(deps.reprobe !== undefined ? { reprobe: deps.reprobe } : {}),
      ...(deps.anthropicHolder !== undefined ? { anthropicHolder: deps.anthropicHolder } : {}),
      ...(deps.applianceSecrets !== undefined ? { applianceSecrets: deps.applianceSecrets } : {}),
      ...(deps.bootstrapApiKey !== undefined ? { bootstrapApiKey: deps.bootstrapApiKey } : {}),
      ...(deps.probeFn !== undefined ? { probeFn: deps.probeFn } : {}),
    }),
  );

  // Everything else under /v1 requires a valid Vibe-issued tenant API key.
  const v1 = express.Router();
  v1.use(apiKeyMiddleware(deps.apiKeys));
  v1.use(
    messagesRouter({
      engine: deps.engine,
      getAnthropic,
      vault: deps.vault,
      sessions: deps.sessions,
      apiKeys: deps.apiKeys,
      defaultSessionTtlMinutes: deps.sessionTtlMinutes,
      ...(getAnthropicSdk !== undefined ? { getAnthropicSdk } : {}),
      ...(deps.rateLimiter !== undefined ? { rateLimiter: deps.rateLimiter } : {}),
      ...(deps.spendTracker !== undefined ? { spendTracker: deps.spendTracker } : {}),
      ...(deps.policies !== undefined ? { policies: deps.policies } : {}),
      ...(deps.zdrEnabled !== undefined ? { zdrEnabled: deps.zdrEnabled } : {}),
      ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
      ...(deps.recognizerMisses !== undefined ? { recognizerMisses: deps.recognizerMisses } : {}),
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
