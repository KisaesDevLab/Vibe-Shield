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
 * Any of 1-3 raises and the process exits before listening.
 */

import {
  ApiKeyStore,
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
import { PerTenantKeyResolver } from './tenant-key/resolver.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // Fail-closed: verify the KEK is loadable before we accept traffic.
  const kek = loadKek();
  logger.info({ kek_status: 'loaded' }, 'kek loaded');

  // Anthropic client + commercial-key probe. The probe hits Anthropic
  // directly via fetch so it isn't coupled to a specific SDK version
  // surface.
  const probe = await probeAnthropicKey({ apiKey: config.ANTHROPIC_API_KEY });
  logger.info(
    { models_visible: probe.models.length },
    'anthropic commercial-key probe ok',
  );
  const anthropic = createAnthropicClient({
    apiKey: config.ANTHROPIC_API_KEY,
    ...(config.ZDR_ENABLED ? { zdr: true } : {}),
  });

  // DB-backed services. TokenVault gets its DEKs from
  // PerTenantKeyResolver, which is constructed per-process (cached
  // DEKs are wiped on shutdown).
  const dbHandle = createDatabase(config.DATABASE_URL);
  const apiKeys = new ApiKeyStore(dbHandle.db);
  const sessions = new SessionManager(dbHandle.db);
  const tenantKeys = new PerTenantKeyResolver(dbHandle.db, kek);
  const vault = new TokenVault(dbHandle.db, tenantKeys);

  const engine = new EngineClient({ baseUrl: config.ENGINE_URL });

  const app = createApp({
    db: dbHandle.db,
    apiKeys,
    sessions,
    vault,
    engine,
    anthropic,
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
      void dbHandle.close().then(() => process.exit(0));
    });
    // Hard floor so we don't hang forever.
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
