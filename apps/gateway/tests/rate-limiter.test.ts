import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RateLimitExceededError,
  RateLimiter,
} from '../src/quota/rate-limiter.js';

interface FakeRedis {
  store: Map<string, { count: number; expireAt: number }>;
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
}

function fakeRedis(): FakeRedis {
  const store = new Map<string, { count: number; expireAt: number }>();
  return {
    store,
    incr: (key) => {
      const now = Date.now();
      const existing = store.get(key);
      if (existing && existing.expireAt > now) {
        existing.count += 1;
        return Promise.resolve(existing.count);
      }
      store.set(key, { count: 1, expireAt: now + 60_000 });
      return Promise.resolve(1);
    },
    expire: (key, seconds) => {
      const cur = store.get(key);
      if (cur) cur.expireAt = Date.now() + seconds * 1000;
      return Promise.resolve(1);
    },
  };
}

describe('RateLimiter', () => {
  let r: FakeRedis;
  beforeEach(() => {
    r = fakeRedis();
  });
  afterEach(() => {
    r.store.clear();
  });

  it('allows requests under the cap', async () => {
    const rl = new RateLimiter({ redis: r as unknown as never, defaultLimit: 5 });
    for (let i = 0; i < 5; i++) {
      await rl.check('t1', 'app1');
    }
  });

  it('throws after the cap', async () => {
    const rl = new RateLimiter({ redis: r as unknown as never, defaultLimit: 3 });
    await rl.check('t1', 'app1');
    await rl.check('t1', 'app1');
    await rl.check('t1', 'app1');
    await expect(rl.check('t1', 'app1')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it('isolates tenants', async () => {
    const rl = new RateLimiter({ redis: r as unknown as never, defaultLimit: 1 });
    await rl.check('t1', 'app1');
    await rl.check('t2', 'app1');
  });

  it('isolates apps within a tenant', async () => {
    const rl = new RateLimiter({ redis: r as unknown as never, defaultLimit: 1 });
    await rl.check('t1', 'app1');
    await rl.check('t1', 'app2');
  });

  it('honors per-call override', async () => {
    const rl = new RateLimiter({ redis: r as unknown as never, defaultLimit: 1 });
    await rl.check('t1', 'app1', 5);
    await rl.check('t1', 'app1', 5);
    // A subsequent default-limit call would normally pass — but the
    // counter is shared across calls regardless of the override, so the
    // 3rd hit using default=1 triggers since count is now 3.
    await expect(rl.check('t1', 'app1')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it('error includes a Retry-After hint', async () => {
    const rl = new RateLimiter({ redis: r as unknown as never, defaultLimit: 1 });
    await rl.check('t1', 'app1');
    try {
      await rl.check('t1', 'app1');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExceededError);
      expect((err as RateLimitExceededError).retryAfterSeconds).toBeGreaterThan(0);
      expect((err as RateLimitExceededError).retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });
});
