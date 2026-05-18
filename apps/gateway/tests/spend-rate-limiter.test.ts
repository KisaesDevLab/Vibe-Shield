/**
 * SpendRateLimiter — Phase 25 G2.8.
 *
 * Uses an in-memory Redis stub so the test doesn't need a real Redis.
 * The stub implements only the subset we touch: get, incrby, expire.
 */

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  SpendRateLimitExceededError,
  SpendRateLimiter,
} from '../src/quota/spend-rate-limiter.js';

class FakeRedis {
  private values = new Map<string, number>();
  private ttls = new Map<string, number>();
  get(key: string): Promise<string | null> {
    const v = this.values.get(key);
    return Promise.resolve(v === undefined ? null : String(v));
  }
  incrby(key: string, delta: number): Promise<number> {
    const next = (this.values.get(key) ?? 0) + delta;
    this.values.set(key, next);
    return Promise.resolve(next);
  }
  expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);
    return Promise.resolve(1);
  }
}

function newLimiter(opts: {
  capMicrodollars: bigint;
  onSoftWarn?: (info: {
    tenantId: string;
    currentMicrodollars: bigint;
    capMicrodollars: bigint;
  }) => void;
}): { limiter: SpendRateLimiter; redis: FakeRedis } {
  const redis = new FakeRedis();
  const limiter = new SpendRateLimiter({
    redis: redis as unknown as import('ioredis').Redis,
    defaultCapMicrodollars: opts.capMicrodollars,
    logger: pino({ level: 'silent' }),
    ...(opts.onSoftWarn !== undefined ? { onSoftWarn: opts.onSoftWarn } : {}),
  });
  return { limiter, redis };
}

describe('SpendRateLimiter', () => {
  it('enabled is false when cap is 0', () => {
    const { limiter } = newLimiter({ capMicrodollars: 0n });
    expect(limiter.enabled).toBe(false);
  });

  it('check passes when the bucket is empty', async () => {
    const { limiter } = newLimiter({ capMicrodollars: 1_000_000n });
    await expect(limiter.check('tenant-a')).resolves.toBeUndefined();
  });

  it('record adds cost; check throws once the cap is reached', async () => {
    const { limiter } = newLimiter({ capMicrodollars: 1_000_000n });
    await limiter.record('tenant-a', 500_000n);
    await limiter.record('tenant-a', 500_000n);
    // Now at 1_000_000 — at the cap. Next check throws.
    await expect(limiter.check('tenant-a')).rejects.toBeInstanceOf(
      SpendRateLimitExceededError,
    );
  });

  it('per-tenant isolation', async () => {
    const { limiter } = newLimiter({ capMicrodollars: 1_000_000n });
    await limiter.record('tenant-a', 1_000_000n);
    // Tenant B is untouched.
    await expect(limiter.check('tenant-b')).resolves.toBeUndefined();
    // Tenant A is over.
    await expect(limiter.check('tenant-a')).rejects.toBeInstanceOf(
      SpendRateLimitExceededError,
    );
  });

  it('soft-warn fires once on the 80% crossing', async () => {
    const onSoftWarn = vi.fn();
    const { limiter } = newLimiter({
      capMicrodollars: 1_000_000n,
      onSoftWarn,
    });
    await limiter.record('tenant-x', 700_000n); // 70% — below threshold
    expect(onSoftWarn).not.toHaveBeenCalled();
    await limiter.record('tenant-x', 100_000n); // 80% — crosses
    expect(onSoftWarn).toHaveBeenCalledTimes(1);
    await limiter.record('tenant-x', 50_000n); // 85% — no extra warn
    expect(onSoftWarn).toHaveBeenCalledTimes(1);
  });

  it('cap=0 short-circuits both check and record', async () => {
    const onSoftWarn = vi.fn();
    const { limiter } = newLimiter({ capMicrodollars: 0n, onSoftWarn });
    await limiter.check('tenant-x');
    await limiter.record('tenant-x', 9_999_999n);
    expect(onSoftWarn).not.toHaveBeenCalled();
  });

  it('thrown error exposes retryAfterSeconds within the next window', async () => {
    const { limiter } = newLimiter({ capMicrodollars: 1n });
    await limiter.record('tenant-z', 1n);
    try {
      await limiter.check('tenant-z');
      expect.fail('expected check to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpendRateLimitExceededError);
      const r = err as SpendRateLimitExceededError;
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
      expect(r.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });
});
