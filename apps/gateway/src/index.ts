/**
 * Gateway entry point. Wires real deps from env, starts the HTTP
 * server, registers graceful shutdown.
 */

import {
  ApiKeyStore,
  SessionManager,
  createDatabase,
  loadKek,
} from '@kisaesdevlab/vibe-shield-schema';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // Fail-closed: verify the KEK is loadable before we accept traffic.
  // Throws if VS_KEK is missing or malformed; the process exits before
  // serving anything.
  loadKek();
  logger.info({ kek_status: 'loaded' }, 'kek loaded');

  const dbHandle = createDatabase(config.DATABASE_URL);
  const apiKeys = new ApiKeyStore(dbHandle.db);
  const sessions = new SessionManager(dbHandle.db);

  const app = createApp({
    db: dbHandle.db,
    apiKeys,
    sessions,
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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void dbHandle.close().then(() => process.exit(0));
    });
    // Hard floor so we don't hang forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const logger = createLogger();
  logger.fatal(
    { error_class: err instanceof Error ? err.name : 'Unknown' },
    'gateway startup failed',
  );
  process.exit(1);
});
