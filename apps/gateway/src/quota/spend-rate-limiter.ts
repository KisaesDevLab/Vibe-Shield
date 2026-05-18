/**
 * Per-tenant per-minute spend rate limiter — Phase 25 G2.8.
 *
 * Sits alongside the existing month-cap (``SpendTracker``). Where the
 * month-cap stops sustained spend, this stops the *rate* of spend so
 * a runaway worker can't burn through a month of budget in 10 minutes.
 *
 * Redis-backed fixed window (60s). The window is checked BEFORE the
 * call (anti-runaway: refuse if already over) and incremented AFTER
 * the call returns with a known cost (matches the SpendTracker
 * record() pattern). This is intentionally not leaky-bucket-continuous
 * — fixed windows are simpler, the boundary 2× burst is acceptable
 * for budget protection, and the implementation is one INCRBY +
 * EXPIRE.
 *
 * Three thresholds:
 *   - 0–79%      green:  no action
 *   - 80–99%     warn:   logger.warn + optional callback (audit hook)
 *   - 100%       red:    throws SpendRateLimitExceededError; orchestrator
 *                        maps to 429 + Retry-After.
 *
 * Configurable via ``SPEND_RATE_PER_MINUTE_MICRODOLLARS``. Default
 * 100_000_000 ($100/min) — high enough that no legitimate workload
 * notices, low enough that a stuck loop hits it within a few minutes.
 * Set to 0 to disable.
 */

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export class SpendRateLimitExceededError extends Error {
  override readonly name = 'SpendRateLimitExceededError';
  constructor(
    readonly capMicrodollars: bigint,
    readonly currentMicrodollars: bigint,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `spend rate cap exceeded: $${(Number(currentMicrodollars) / 1_000_000).toFixed(2)}` +
        `/$${(Number(capMicrodollars) / 1_000_000).toFixed(2)}/min`,
    );
  }
}

export interface SpendRateLimiterDeps {
  redis: Redis;
  /** Cap per tenant per minute, micro-dollars. 0 disables. */
  defaultCapMicrodollars: bigint;
  /** Window length in seconds. Default 60. */
  windowSeconds?: number;
  /** Logger for soft-warn at 80%. */
  logger: Logger;
  /** Optional callback invoked on soft-warn (≥80%) — for audit hook. */
  onSoftWarn?: (info: {
    tenantId: string;
    currentMicrodollars: bigint;
    capMicrodollars: bigint;
  }) => void;
}

export class SpendRateLimiter {
  private readonly windowSeconds: number;
  constructor(private readonly deps: SpendRateLimiterDeps) {
    this.windowSeconds = deps.windowSeconds ?? 60;
  }

  /** True iff a cap is configured (>0). */
  get enabled(): boolean {
    return this.deps.defaultCapMicrodollars > 0n;
  }

  /**
   * Pre-flight check. Throws if the tenant is already at or over the
   * cap for the current window. Cheap: one GET round-trip.
   */
  async check(tenantId: string, capOverride?: bigint): Promise<void> {
    const cap = capOverride ?? this.deps.defaultCapMicrodollars;
    if (cap <= 0n) return;
    const { key, retryAfter } = this.keyFor(tenantId);
    const raw = await this.deps.redis.get(key);
    const current = raw === null ? 0n : BigInt(raw);
    if (current >= cap) {
      throw new SpendRateLimitExceededError(cap, current, retryAfter);
    }
  }

  /**
   * Post-flight: record a completed call's cost. May emit a soft-warn
   * if the new total crosses the 80% mark, but does not throw — the
   * call already happened.
   */
  async record(
    tenantId: string,
    costMicrodollars: bigint,
    capOverride?: bigint,
  ): Promise<void> {
    const cap = capOverride ?? this.deps.defaultCapMicrodollars;
    if (cap <= 0n || costMicrodollars <= 0n) return;
    const { key } = this.keyFor(tenantId);
    // ioredis INCRBY returns the new value as a string for bigints.
    // We use INCRBYFLOAT? No — costs are integer microdollars, so
    // INCRBY works cleanly and atomically.
    const newTotalNum = await this.deps.redis.incrby(
      key,
      Number(costMicrodollars),
    );
    const newTotal = BigInt(newTotalNum);
    if (newTotal === BigInt(costMicrodollars)) {
      // First hit in this window — set the TTL so the key expires.
      await this.deps.redis.expire(key, this.windowSeconds + 5);
    }
    if (
      newTotal >= (cap * 80n) / 100n &&
      newTotal - BigInt(costMicrodollars) < (cap * 80n) / 100n
    ) {
      // Crossed the 80% mark this call. Log once per crossing.
      this.deps.logger.warn(
        {
          tenant_id: tenantId,
          current_microdollars: newTotal.toString(),
          cap_microdollars: cap.toString(),
          window_seconds: this.windowSeconds,
        },
        'spend rate at soft-warn threshold (≥80%)',
      );
      this.deps.onSoftWarn?.({
        tenantId,
        currentMicrodollars: newTotal,
        capMicrodollars: cap,
      });
    }
  }

  private keyFor(tenantId: string): { key: string; retryAfter: number } {
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / this.windowSeconds);
    const key = `vs:srl:${tenantId}:${window.toString()}`;
    const retryAfter = (window + 1) * this.windowSeconds - now;
    return { key, retryAfter: Math.max(retryAfter, 1) };
  }
}
