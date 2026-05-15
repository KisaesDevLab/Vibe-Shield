import {
  ApiKeyStore,
  SessionManager,
  createDatabase,
  type DatabaseHandle,
  runMigrations,
} from '@kisaesdevlab/vibe-shield-schema';
import pino, { type Logger } from 'pino';
import { createApp } from '../src/app.js';

export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? process.env['VIBE_SHIELD_DATABASE_URL'];

export const integrationEnabled =
  DATABASE_URL !== undefined && DATABASE_URL !== '';

export async function freshDatabase(): Promise<DatabaseHandle> {
  if (!integrationEnabled || DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL not set');
  }
  const handle = createDatabase(DATABASE_URL, { max: 5 });
  await runMigrations(handle, { fresh: true });
  return handle;
}

export function silentLogger(): Logger {
  // pino's default level is "info"; "silent" suppresses everything so
  // test output isn't polluted by access logs.
  return pino({ level: 'silent' });
}

export function buildTestApp(deps: {
  handle: DatabaseHandle;
  apiKeys?: ApiKeyStore;
  sessions?: SessionManager;
}) {
  const apiKeys = deps.apiKeys ?? new ApiKeyStore(deps.handle.db);
  const sessions = deps.sessions ?? new SessionManager(deps.handle.db);
  return createApp({
    db: deps.handle.db,
    apiKeys,
    sessions,
    logger: silentLogger(),
    maxRequestBytes: 64 * 1024,
    sessionTtlMinutes: 60,
  });
}
