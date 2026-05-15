import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/proxy/retry.js';

describe('withRetry', () => {
  it('returns first success', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(op);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and eventually succeeds', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(() => {
      n += 1;
      if (n < 3) {
        const e = Object.assign(new Error('upstream'), { status: 503 });
        return Promise.reject(e);
      }
      return Promise.resolve('eventually');
    });
    const result = await withRetry(op, { baseDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe('eventually');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('retries 429 the same as 5xx', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(() => {
      n += 1;
      if (n < 2) {
        return Promise.reject(Object.assign(new Error('rate'), { status: 429 }));
      }
      return Promise.resolve('ok');
    });
    await withRetry(op, { baseDelayMs: 1 });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx (other than 429)', async () => {
    const op = vi.fn().mockRejectedValue(
      Object.assign(new Error('bad request'), { status: 400 }),
    );
    await expect(withRetry(op)).rejects.toMatchObject({ status: 400 });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const op = vi.fn().mockRejectedValue(
      Object.assign(new Error('upstream'), { status: 502 }),
    );
    await expect(
      withRetry(op, { maxAttempts: 2, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ status: 502 });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does not retry errors without status', async () => {
    const op = vi.fn().mockRejectedValue(new Error('our bug'));
    await expect(withRetry(op)).rejects.toThrow('our bug');
    expect(op).toHaveBeenCalledTimes(1);
  });
});
