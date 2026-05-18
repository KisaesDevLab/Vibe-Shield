/**
 * Re-exports of the @anthropic-ai/sdk types the rest of the gateway
 * needs. Phase 25 G2.9 — the no-restricted-imports rule treats this
 * directory as the only legal place to touch the SDK package; consumers
 * import from here instead so the boundary check stays clean.
 */

export type { default as Anthropic } from '@anthropic-ai/sdk';
export type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/messages.mjs';
