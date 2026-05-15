/**
 * Response re-identification.
 *
 * Walks every string field in Anthropic's response (text content
 * blocks, tool_use.input, tool_result.content) and replaces vault
 * tokens with cleartext. Unknown tokens (not allocated for this
 * session) pass through untouched — Anthropic occasionally hallucinates
 * angle-bracketed strings that look like our tokens; we must never
 * "resolve" those.
 *
 * Phase 8 implements full re-identification only. Phase 9 will add
 * policy gating (full / partial / none, per-user permissions). For
 * now we always resolve every token we know about.
 */

import type { TokenVault } from '@kisaesdevlab/vibe-shield-schema';
import type { Message } from '@anthropic-ai/sdk/resources/messages.mjs';

const TOKEN_RE = /<([A-Z][A-Z_]*?)_(\d+)>/g;

export interface ReidentifierDeps {
  vault: TokenVault;
  sessionId: string;
}

export async function reidentifyResponse(
  response: Message,
  deps: ReidentifierDeps,
): Promise<Message> {
  // Deep-clone so the caller's response object isn't mutated.
  const cloned: Message = JSON.parse(JSON.stringify(response)) as Message;
  // Pre-walk to collect every unique token mentioned in the response;
  // then resolve them all once in parallel and stitch the cleartext
  // back. Cuts O(n*m) DB hits to O(unique-tokens).
  const tokens = new Set<string>();
  collectTokensFromContent(cloned.content as unknown, tokens);

  const resolved = new Map<string, string>();
  await Promise.all(
    Array.from(tokens).map(async (token) => {
      const cleartext = await deps.vault.resolve(deps.sessionId, token);
      if (cleartext !== null) {
        resolved.set(token, cleartext);
      }
    }),
  );

  if (resolved.size === 0) {
    return cloned;
  }

  const replaceTokens = (text: string): string => {
    return text.replace(TOKEN_RE, (match) => {
      return resolved.get(match) ?? match;
    });
  };

  for (const block of cloned.content) {
    if (block.type === 'text') {
      block.text = replaceTokens(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      block.input = walkAndReplace(block.input, replaceTokens);
      continue;
    }
    // tool_result type may appear in assistant content per newer schemas;
    // walk content if present.
    const maybeResult = block as { type: string; content?: unknown };
    if (maybeResult.type === 'tool_result' && maybeResult.content !== undefined) {
      maybeResult.content = walkAndReplace(maybeResult.content, replaceTokens);
    }
  }
  return cloned;
}

function collectTokensFromContent(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN_RE)) {
      into.add(m[0]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTokensFromContent(item, into);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) {
      collectTokensFromContent(v, into);
    }
  }
}

function walkAndReplace(value: unknown, replace: (s: string) => string): unknown {
  if (typeof value === 'string') {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkAndReplace(item, replace));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkAndReplace(v, replace);
    }
    return out;
  }
  return value;
}
