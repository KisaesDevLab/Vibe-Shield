export * from './schema/index.js';
export * from './crypto/index.js';
export * from './vault/index.js';
export type { Database, DatabaseHandle, DatabaseOptions } from './db/index.js';
export { createDatabase } from './db/index.js';
export {
  DEFAULT_MIGRATIONS_DIR,
  dropAllVibeShieldObjects,
  runMigrations,
} from './db/migrate.js';
