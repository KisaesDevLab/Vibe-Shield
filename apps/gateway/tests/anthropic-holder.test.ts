/**
 * AnthropicClientHolder — Phase 23.5 hot-swap correctness.
 */

import { describe, expect, it } from 'vitest';
import { AnthropicClientHolder } from '../src/anthropic/holder.js';

describe('AnthropicClientHolder', () => {
  it('initializes with the boot key and exposes meta', () => {
    const holder = new AnthropicClientHolder({
      apiKey: 'sk-ant-boot',
      zdr: false,
    });
    expect(holder.getApiKey()).toBe('sk-ant-boot');
    expect(holder.getMeta().source).toBe('env');
    expect(holder.getClient()).toBeDefined();
    expect(holder.getSdk()).toBeDefined();
  });

  it('reload swaps both client refs and updates meta', () => {
    const holder = new AnthropicClientHolder({
      apiKey: 'sk-ant-old',
      zdr: false,
    });
    const oldClient = holder.getClient();
    const oldSdk = holder.getSdk();
    holder.reload({
      apiKey: 'sk-ant-new',
      meta: {
        source: 'db',
        setAt: new Date('2026-05-18T00:00:00Z'),
        fingerprint: 'deadbeefcafebabe',
      },
    });
    expect(holder.getApiKey()).toBe('sk-ant-new');
    expect(holder.getMeta().source).toBe('db');
    expect(holder.getMeta().fingerprint).toBe('deadbeefcafebabe');
    // The underlying SDK instances must be different — accessors read
    // through to current refs.
    expect(holder.getClient()).not.toBe(oldClient);
    expect(holder.getSdk()).not.toBe(oldSdk);
  });

  it('respects ZDR header when configured', () => {
    const holder = new AnthropicClientHolder({
      apiKey: 'sk-ant-zdr',
      zdr: true,
    });
    // We can't introspect the SDK's defaultHeaders directly (Anthropic
    // hides them), so this is a smoke test: the holder builds without
    // throwing under ZDR=true.
    expect(holder.getSdk()).toBeDefined();
    expect(holder.getApiKey()).toBe('sk-ant-zdr');
  });
});
