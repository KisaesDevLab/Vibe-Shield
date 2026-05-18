import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicUnreachableError,
  ConsumerKeyError,
} from '../src/anthropic/probe.js';
import { AnthropicKeyReprobe } from '../src/anthropic/reprobe.js';

const silentLogger = pino({ level: 'silent' });

describe('AnthropicKeyReprobe', () => {
  it('runOnce returns ok=true when probe resolves', async () => {
    const r = new AnthropicKeyReprobe({
      getApiKey: () => 'sk-ant-test',
      intervalMs: 0,
      logger: silentLogger,
      probeFn: async () => Promise.resolve({ models: ['claude-opus-4-7'] }),
    });
    expect(await r.runOnce()).toEqual({ ok: true });
  });

  it('runOnce returns reason=consumer_key on ConsumerKeyError', async () => {
    const r = new AnthropicKeyReprobe({
      getApiKey: () => 'sk-bad',
      intervalMs: 0,
      logger: silentLogger,
      probeFn: async () =>
        Promise.reject(new ConsumerKeyError('rejected')) as never,
    });
    expect(await r.runOnce()).toEqual({ ok: false, reason: 'consumer_key' });
  });

  it('runOnce returns reason=unreachable on AnthropicUnreachableError', async () => {
    const r = new AnthropicKeyReprobe({
      getApiKey: () => 'sk-ant-test',
      intervalMs: 0,
      logger: silentLogger,
      probeFn: async () =>
        Promise.reject(new AnthropicUnreachableError('500')) as never,
    });
    expect(await r.runOnce()).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('runOnce returns reason=unknown on generic error', async () => {
    const r = new AnthropicKeyReprobe({
      getApiKey: () => 'sk-ant-test',
      intervalMs: 0,
      logger: silentLogger,
      probeFn: async () => Promise.reject(new Error('boom')) as never,
    });
    expect(await r.runOnce()).toEqual({ ok: false, reason: 'unknown' });
  });

  it('start is a no-op when intervalMs <= 0', () => {
    const r = new AnthropicKeyReprobe({
      getApiKey: () => 'sk-ant-test',
      intervalMs: 0,
      logger: silentLogger,
    });
    r.start();
    // No timer created — stop() must be safe to call.
    r.stop();
  });

  it('start fires probe at interval; stop cancels', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const r = new AnthropicKeyReprobe({
        getApiKey: () => 'sk-ant-test',
        intervalMs: 1000,
        logger: silentLogger,
        probeFn: async () => {
          calls++;
          return Promise.resolve({ models: [] });
        },
      });
      r.start();
      await vi.advanceTimersByTimeAsync(1000);
      // setInterval kicks off the async probe; wait a microtask for it to settle.
      await Promise.resolve();
      expect(calls).toBeGreaterThanOrEqual(1);
      const after = calls;
      r.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onProbe callback receives result', async () => {
    const seen: Array<{ ok: boolean; reason?: string }> = [];
    const r = new AnthropicKeyReprobe({
      getApiKey: () => 'sk-ant-test',
      intervalMs: 0,
      logger: silentLogger,
      probeFn: async () => Promise.resolve({ models: [] }),
      onProbe: (result) => seen.push(result),
    });
    await r.runOnce();
    expect(seen).toEqual([{ ok: true }]);
  });
});
