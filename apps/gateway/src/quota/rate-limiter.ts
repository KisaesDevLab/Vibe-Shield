/**
 * Per-tenant fixed-window rate limiter (Redis-backed).
 *
 * Window: 60 seconds. Quota: configurable per (tenant, app), default 60.
 *
 * Fixed window is simpler than sliding (no sorted sets, single INCR
 * round-trip), at the cost of allowing 2x the quota at the boundary
 * between windows. Acceptable for v1's traffic profile; revisit if
 * the cap shows up in burst-shaped abuse.
 */

import type { Redis } from 'ioredis';

export class RateLimitExceededError extends Error {
  override readonly name = 'RateLimitExceededError';
  constructor(
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(`rate limit exceeded: ${limit.toString()} req/min`);
  }
}

export interface RateLimiterDeps {
  redis: Redis;
  /** Default per-(tenant,app) limit per window. Default 60/min. */
  defaultLimit?: number;
  /** Window length in seconds. Default 60. */
  windowSeconds?: number;
}

export class RateLimiter {
  private readonly defaultLimit: number;
  private readonly windowSeconds: number;

  constructor(private readonly deps: RateLimiterDeps) {
    this.defaultLimit = deps.defaultLimit ?? 60;
    this.windowSeconds = deps.windowSeconds ?? 60;
  }

  /**
   * Increment + check. Throws ``RateLimitExceededError`` past the cap.
   * Pass an explicit ``limit`` to override the default for a tenant
   * with a custom policy.
   */
  async check(tenantId: string, appId: string, limit?: number): Promise<void> {
    const cap = limit ?? this.defaultLimit;
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / this.windowSeconds);
    const key = `vs:rl:${tenantId}:${appId}:${window.toString()}`;
    const count = await this.deps.redis.incr(key);
    if (count === 1) {
      // First hit in this window — set the TTL so the key garbage-
      // collects itself once the window passes.
      await this.deps.redis.expire(key, this.windowSeconds + 5);
    }
    if (count > cap) {
      const retryAfter = (window + 1) * this.windowSeconds - now;
      throw new RateLimitExceededError(cap, Math.max(retryAfter, 1));
    }
  }
}
