/**
 * Anthropic SDK wrapper.
 *
 * Centralizes auth header injection, ZDR opt-in headers (when
 * configured), and the minimal interface the proxy actually uses. The
 * proxy depends on this interface; tests inject a mock implementation
 * that returns canned responses without ever hitting the network.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages.mjs';

export interface AnthropicClientOptions {
  apiKey: string;
  /** Opt in to Zero Data Retention. Set only when the firm's account
   *  has the ZDR addendum signed. The SDK forwards this as the
   *  anthropic-version-specific beta header. */
  zdr?: boolean;
  /** Override base URL for tests or staging mirrors. */
  baseURL?: string;
}

/** Minimal interface the proxy depends on — easy to mock in tests. */
export interface AnthropicMessagesClient {
  models: { list: (opts?: { limit?: number }) => Promise<{ data: { id: string }[] }> };
  messages: {
    create: (params: MessageCreateParamsNonStreaming) => Promise<Message>;
  };
}

export function createAnthropicClient(opts: AnthropicClientOptions): AnthropicMessagesClient {
  const defaultHeaders: Record<string, string> = {};
  if (opts.zdr === true) {
    // Anthropic's ZDR opt-in is account-scoped; the header marks the
    // request as ZDR-eligible. Per the build plan, this requires the
    // ZDR addendum signed at the account level — the header alone
    // doesn't enable ZDR by itself.
    defaultHeaders['anthropic-zdr'] = 'enabled';
  }
  const constructorOptions: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: opts.apiKey,
    defaultHeaders,
  };
  if (opts.baseURL !== undefined) {
    constructorOptions.baseURL = opts.baseURL;
  }
  const client = new Anthropic(constructorOptions);
  return client as unknown as AnthropicMessagesClient;
}
