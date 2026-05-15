/**
 * Policy resolver.
 *
 * BUILD_PLAN §10 priority: request → user → app → tenant → built-in.
 * The request can supply ``policy_name``; otherwise we fall back
 * through the chain. v1 implements: request name override → built-in
 * by app → DEFAULT_POLICY. Per-user / per-tenant overrides arrive
 * with the Phase 13 admin UI when operators can store custom rows.
 */

import { eq } from 'drizzle-orm';
import {
  type Database,
  policies as policiesTable,
} from '@kisaesdevlab/vibe-shield-schema';
import { BUILT_IN_POLICIES, DEFAULT_POLICY } from './built-in.js';
import {
  policyConfigSchema,
  type PolicyConfig,
} from './schema.js';

export interface ResolveContext {
  tenantId: string;
  appId: string;
  /** Explicit policy name from the request. Highest priority. */
  requestedPolicy?: string;
}

export class PolicyResolver {
  /** In-memory cache of built-in + DB policies by name. */
  private cache: Map<string, PolicyConfig> = new Map();
  private loaded = false;

  constructor(private readonly db: Database) {
    for (const p of BUILT_IN_POLICIES) {
      this.cache.set(p.name, p);
    }
  }

  /** Load custom policies from vs_policies (latest version per name). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const rows = await this.db.select().from(policiesTable);
    // Latest version per name wins.
    const byName = new Map<string, { version: number; config: PolicyConfig }>();
    for (const row of rows) {
      const parsed = policyConfigSchema.safeParse(row.jsonConfig);
      if (!parsed.success) continue;
      const existing = byName.get(row.name);
      if (existing === undefined || row.version > existing.version) {
        byName.set(row.name, { version: row.version, config: parsed.data });
      }
    }
    for (const { config } of byName.values()) {
      this.cache.set(config.name, config);
    }
    this.loaded = true;
  }

  /**
   * Resolve the effective policy for a request. Chain:
   *   1. ``ctx.requestedPolicy`` if provided AND the policy lists this
   *      app in ``allowed_apps`` (or has no app restriction).
   *   2. The built-in tied to ``ctx.appId`` (e.g. mybooks →
   *      cpa-bookkeeping-balanced).
   *   3. DEFAULT_POLICY.
   */
  async resolve(ctx: ResolveContext): Promise<PolicyConfig> {
    await this.ensureLoaded();
    if (ctx.requestedPolicy !== undefined) {
      const named = this.cache.get(ctx.requestedPolicy);
      if (named !== undefined && this.appAllowed(named, ctx.appId)) {
        return named;
      }
    }
    for (const policy of this.cache.values()) {
      if (policy.allowed_apps.length === 0) continue;
      if (this.appAllowed(policy, ctx.appId)) {
        return policy;
      }
    }
    return DEFAULT_POLICY;
  }

  /** Persist a new version of a policy. Append-only: increments version. */
  async save(config: PolicyConfig): Promise<void> {
    const existing = await this.db
      .select({ version: policiesTable.version })
      .from(policiesTable)
      .where(eq(policiesTable.name, config.name));
    const nextVersion = existing.length === 0
      ? 1
      : Math.max(...existing.map((r) => r.version)) + 1;
    await this.db.insert(policiesTable).values({
      name: config.name,
      version: nextVersion,
      jsonConfig: config,
    });
    this.cache.set(config.name, config);
  }

  list(): PolicyConfig[] {
    return Array.from(this.cache.values());
  }

  private appAllowed(policy: PolicyConfig, appId: string): boolean {
    return policy.allowed_apps.length === 0 || policy.allowed_apps.includes(appId);
  }
}
