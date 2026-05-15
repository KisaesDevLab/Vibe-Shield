/**
 * Gateway entry point. Wires real deps from env, starts the HTTP
 * server, registers graceful shutdown.
 *
 * Fail-closed startup contract:
 *   1. Config parse must succeed (zod-validated env).
 *   2. KEK must load (32 base64 bytes from VS_KEK).
 *   3. Anthropic key must pass the commercial-key probe.
 *   4. DB must accept the connection (lazy — the first /ready or
 *      first request fails if it doesn't).
 *   5. Redis must accept the connection (lazy — first quota check).
 * Any of 1-3 raises and the process exits before listening.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import {
  ApiKeyStore,
  AuditLogger,
  SessionManager,
  TokenVault,
  createDatabase,
  loadKek,
} from '@kisaesdevlab/vibe-shield-schema';
import { createAnthropicClient } from './anthropic/client.js';
import { probeAnthropicKey } from './anthropic/probe.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { EngineClient } from './engine/client.js';
import { createLogger } from './logging.js';
import { PolicyResolver } from './policy/resolver.js';
import { RateLimiter } from './quota/rate-limiter.js';
import { SpendTracker } from './quota/spend-cap.js';
import { PerTenantKeyResolver } from './tenant-key/resolver.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const kek = loadKek();
  logger.info({ kek_status: 'loaded' }, 'kek loaded');

  const probe = await probeAnthropicKey({ apiKey: config.ANTHROPIC_API_KEY });
  logger.info(
    { models_visible: probe.models.length },
    'anthropic commercial-key probe ok',
  );
  const anthropic = createAnthropicClient({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ZDR_ENABLED ? { zdr: true } : {}),
  });
  const anthropicSdk = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ZDR_ENABLED ? { defaultHeaders: { 'anthropic-zdr': 'enabled' } } : {}),
  });

  const dbHandle = createDatabase(config.DATABASE_URL);
  const apiKeys = new ApiKeyStore(dbHandle.db);
  const sessions = new SessionManager(dbHandle.db);
  const tenantKeys = new PerTenantKeyResolver(dbHandle.db, kek);
  const vault = new TokenVault(dbHandle.db, tenantKeys);

  const engine = new EngineClient({ baseUrl: config.ENGINE_URL });

  const redis = new Redis(config.REDIS_URL, { lazyConnect: true });
  const rateLimiter = new RateLimiter({
    redis,
    defaultLimit: config.RATE_LIMIT_PER_MINUTE,
  });
  const spendTracker = new SpendTracker({
    db: dbHandle.db,
    defaultCapMicrodollars: BigInt(config.SPEND_CAP_MICRODOLLARS),
  });

  const policies = new PolicyResolver(dbHandle.db);
  await policies.ensureLoaded();

  const audit = new AuditLogger(dbHandle.db);

  const app = createApp({
    db: dbHandle.db,
    apiKeys,
    sessions,
    vault,
    engine,
    anthropic,
    anthropicSdk,
    rateLimiter,
    spendTracker,
    policies,
    zdrEnabled: config.ZDR_ENABLED,
    audit,
    logger,
    maxRequestBytes: config.MAX_REQUEST_BYTES,
    sessionTtlMinutes: config.SESSION_TTL_MINUTES,
    engineUrl: config.ENGINE_URL,
  });

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(
      { host: config.HOST, port: config.PORT, engine_url: config.ENGINE_URL },
      'gateway listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      tenantKeys.clear();
      void redis.quit().catch(() => undefined);
      void dbHandle.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const logger = createLogger();
  logger.fatal(
    { error_class: err instanceof Error ? err.name : 'Unknown' },
    'gateway startup failed',
  );
  process.exit(1);
});
