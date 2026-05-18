/**
 * AnthropicClientHolder — Phase 23.5 hot-swappable Anthropic client.
 *
 * Before Phase 23.5 the gateway constructed one ``createAnthropicClient``
 * + one raw ``Anthropic`` SDK at boot from ``ANTHROPIC_API_KEY``; routes
 * captured those references at router-build time. Rotating the key
 * required a container restart.
 *
 * Phase 23.5 lets an admin paste a new key in the SPA and have the
 * gateway pick it up on the *next* request without a restart. The
 * mechanism: this holder. Routes call ``getClient()`` / ``getSdk()``
 * per-request, so they always see the current backing instance. The
 * admin endpoint calls ``reload()`` after a successful probe; the swap
 * is atomic from the perspective of any single ``getClient()`` /
 * ``getSdk()`` call. In-flight requests that already captured a
 * reference complete against the prior key (they were authorized
 * against it, so that's safe).
 *
 * The holder also owns the ``getApiKey()`` accessor that the reprobe
 * loop uses — when the key rotates, the next reprobe automatically
 * targets the new key.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  createAnthropicClient,
  type AnthropicMessagesClient,
} from './client.js';

export interface AnthropicHolderInit {
  apiKey: string;
  zdr: boolean;
  baseURL?: string;
}

/** Captured at the moment ``reload`` was called — for audit + admin UI. */
export interface AnthropicKeyMeta {
  source: 'env' | 'db';
  /** When ``source==='db'``, the persisted ``set_at``. Null for env. */
  setAt: Date | null;
  /** Short fingerprint (16 hex chars). */
  fingerprint: string | null;
}

export class AnthropicClientHolder {
  private clientRef: AnthropicMessagesClient;
  private sdkRef: Anthropic;
  private apiKey: string;
  private readonly zdr: boolean;
  private readonly baseURL: string | undefined;
  private meta: AnthropicKeyMeta;

  constructor(init: AnthropicHolderInit & { meta?: AnthropicKeyMeta }) {
    this.apiKey = init.apiKey;
    this.zdr = init.zdr;
    this.baseURL = init.baseURL;
    this.clientRef = this.buildWrappedClient();
    this.sdkRef = this.buildSdk();
    this.meta = init.meta ?? {
      source: 'env',
      setAt: null,
      fingerprint: null,
    };
  }

  /** Routes/orchestrator call this per-request. */
  getClient(): AnthropicMessagesClient {
    return this.clientRef;
  }

  /** Streaming path needs the raw SDK for ``messages.stream``. */
  getSdk(): Anthropic {
    return this.sdkRef;
  }

  /** Reprobe loop pulls the current key. */
  getApiKey(): string {
    return this.apiKey;
  }

  getMeta(): AnthropicKeyMeta {
    return this.meta;
  }

  /**
   * Atomically swap to a new key. Caller is responsible for having
   * already validated the new key against the commercial-key probe.
   */
  reload(opts: { apiKey: string; meta: AnthropicKeyMeta }): void {
    this.apiKey = opts.apiKey;
    this.clientRef = this.buildWrappedClient();
    this.sdkRef = this.buildSdk();
    this.meta = opts.meta;
  }

  private buildWrappedClient(): AnthropicMessagesClient {
    const opts: { apiKey: string; zdr?: boolean; baseURL?: string } = {
      apiKey: this.apiKey,
    };
    if (this.zdr) opts.zdr = true;
    if (this.baseURL !== undefined) opts.baseURL = this.baseURL;
    return createAnthropicClient(opts);
  }

  private buildSdk(): Anthropic {
    const ctor: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: this.apiKey,
    };
    if (this.zdr) {
      ctor.defaultHeaders = { 'anthropic-zdr': 'enabled' };
    }
    if (this.baseURL !== undefined) {
      ctor.baseURL = this.baseURL;
    }
    return new Anthropic(ctor);
  }
}
