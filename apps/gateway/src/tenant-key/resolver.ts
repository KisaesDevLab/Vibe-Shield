/**
 * Per-tenant DEK resolver.
 *
 * Looks up the wrapped DEK in vs_tenant_keys, unwraps with the
 * appliance KEK, and caches the cleartext DEK for the request lifetime.
 * If no wrapped DEK exists for the tenant yet, we create one
 * automatically — first-touch provisioning.
 *
 * Caching scope: the resolver lives for the duration of one gateway
 * request (instantiated by the request handler, dropped when the
 * response finishes). Cleartext DEKs never leave the request scope,
 * never persist to disk, never appear in logs.
 */

import { eq } from 'drizzle-orm';
import {
  createWrappedDek,
  type Database,
  tenantKeys,
  type TenantKeyResolver,
  unwrapDek,
} from '@kisaesdevlab/vibe-shield-schema';

export class PerTenantKeyResolver implements TenantKeyResolver {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly db: Database,
    private readonly kek: Buffer,
  ) {}

  async resolve(tenantId: string): Promise<Buffer> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined) {
      return cached;
    }
    const dek = await this.fetchOrProvision(tenantId);
    this.cache.set(tenantId, dek);
    return dek;
  }

  private async fetchOrProvision(tenantId: string): Promise<Buffer> {
    const rows = await this.db
      .select({ wrappedDek: tenantKeys.wrappedDek })
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    if (row !== undefined) {
      return unwrapDek(row.wrappedDek, this.kek, tenantId);
    }
    // First-touch provisioning: mint a new DEK, wrap it, persist. If
    // two requests race, the unique PK on tenant_id means one INSERT
    // wins; the loser will see the winner's row on its retry.
    const { wrappedDek, dek } = createWrappedDek(this.kek, tenantId);
    try {
      await this.db.insert(tenantKeys).values({ tenantId, wrappedDek });
      return dek;
    } catch {
      // Race resolved by the unique PK — re-read the winner's row.
      const refresh = await this.db
        .select({ wrappedDek: tenantKeys.wrappedDek })
        .from(tenantKeys)
        .where(eq(tenantKeys.tenantId, tenantId))
        .limit(1);
      const winner = refresh[0];
      if (winner === undefined) {
        throw new Error('failed to provision tenant DEK and no winning row found');
      }
      // Discard the locally-minted DEK; trust the persisted one.
      dek.fill(0);
      return unwrapDek(winner.wrappedDek, this.kek, tenantId);
    }
  }

  /**
   * Wipe cached DEKs. Call when the request completes to narrow the
   * window during which cleartext keys live in heap.
   */
  clear(): void {
    for (const dek of this.cache.values()) {
      dek.fill(0);
    }
    this.cache.clear();
  }
}
