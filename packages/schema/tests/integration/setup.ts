/**
 * Shared integration-test scaffolding.
 *
 * Tests skip cleanly when ``DATABASE_URL`` is unset, so contributors can
 * run unit tests offline. CI / local-dev with `make dev` running set
 * the env to ``postgres://vibe:vibe@localhost:5436/vibe_shield``.
 *
 * Each test file gets a fresh schema setup: drop all ``vs_*`` objects
 * then re-apply migrations. Tests within a file share the migrated
 * schema and use unique session UUIDs to avoid row collisions.
 */

import { newKey } from '../../src/crypto/aead.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { TenantKeyResolver } from '../../src/vault/token-vault.js';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.VIBE_SHIELD_DATABASE_URL;

export const integrationEnabled = DATABASE_URL !== undefined && DATABASE_URL !== '';

export async function freshDatabase(): Promise<DatabaseHandle> {
  if (!integrationEnabled || DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL not set');
  }
  const handle = createDatabase(DATABASE_URL, { max: 5, debug: false });
  await runMigrations(handle, { fresh: true });
  return handle;
}

/**
 * Static in-memory key resolver. Generates a stable DEK per tenant on
 * first access. Production uses ``vs_tenant_keys`` + KEK unwrap; tests
 * skip the wrap step because we're testing the vault, not the wrap.
 */
export class StaticKeyResolver implements TenantKeyResolver {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly seed: () => Buffer = newKey) {}

  resolve(tenantId: string): Promise<Buffer> {
    const existing = this.keys.get(tenantId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const fresh = this.seed();
    this.keys.set(tenantId, fresh);
    return Promise.resolve(fresh);
  }
}
