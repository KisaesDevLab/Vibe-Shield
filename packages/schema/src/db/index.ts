/**
 * Database connection factory.
 *
 * Wraps postgres-js + Drizzle. Used by tests, the migration runner, and
 * (Phase 7+) the gateway. We keep the surface tiny so the gateway can
 * inject its own pool config later without touching call sites.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema/index.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  db: Database;
  client: postgres.Sql;
  /** Connection URL — preserved so the migration runner can open a
   *  dedicated max:1 client without parsing the postgres-js options bag. */
  url: string;
  close: () => Promise<void>;
}

export interface DatabaseOptions {
  /** postgres-js connection options. ``max`` defaults to 10. */
  max?: number;
  /** Idle timeout in seconds; default 30. */
  idleTimeout?: number;
  /** Schema search path; useful for test isolation. */
  searchPath?: string[];
  /** Set to true in tests to surface query errors loudly. */
  debug?: boolean;
}

export function createDatabase(url: string, options: DatabaseOptions = {}): DatabaseHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connection: options.searchPath
      ? { search_path: options.searchPath.join(',') }
      : {},
    debug: options.debug ?? false,
    // Map bytea returns to Buffer rather than postgres-js's default Uint8Array
    // so call sites match the schema's customType<{ data: Buffer }> design.
    types: {
      bytea: {
        to: 17,
        from: [17],
        serialize: (x: Buffer) => '\\x' + x.toString('hex'),
        parse: (x: string) => Buffer.from(x.slice(2), 'hex'),
      },
    },
  });
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    url,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}
