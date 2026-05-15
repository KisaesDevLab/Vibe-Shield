/**
 * Response re-identification.
 *
 * Walks every string field in Anthropic's response (text content
 * blocks, tool_use.input, tool_result.content) and replaces vault
 * tokens with cleartext **per the active re-id policy**.
 *
 * Unknown tokens (not allocated for this session) always pass through
 * untouched — Anthropic occasionally hallucinates angle-bracketed
 * strings; we never resolve those.
 *
 * Phase 9: policy gating live. Modes:
 *   - full     → resolve every known token
 *   - partial  → resolve only entity types in policy.allowed_entity_types
 *   - none     → resolve nothing (audit-only mode)
 * Per-role overrides apply if the auth context carries a role.
 */

import type { TokenVault } from '@kisaesdevlab/vibe-shield-schema';
import type { Message } from '@anthropic-ai/sdk/resources/messages.mjs';
import {
  FULL_POLICY,
  type ReidPolicy,
  shouldResolve,
} from '../policy/reid-policy.js';

const TOKEN_RE = /<([A-Z][A-Z_]*?)_(\d+)>/g;

export interface ReidentifierDeps {
  vault: TokenVault;
  sessionId: string;
  policy?: ReidPolicy;
  /** User role for per-role overrides; comes from req.auth.role (Phase 10). */
  role?: string;
}

export async function reidentifyResponse(
  response: Message,
  deps: ReidentifierDeps,
): Promise<Message> {
  const policy = deps.policy ?? FULL_POLICY;

  const cloned: Message = JSON.parse(JSON.stringify(response)) as Message;
  const tokens = new Set<string>();
  collectTokensFromContent(cloned.content as unknown, tokens);

  // Resolve only tokens whose entity type the policy allows for this role.
  // Tokens not allowed remain in the response as-is (caller / downstream
  // may surface them to the user as opaque IDs).
  const resolved = new Map<string, string>();
  await Promise.all(
    Array.from(tokens).map(async (token) => {
      const entityType = parseEntityType(token);
      if (entityType === null) return;
      if (!shouldResolve(policy, deps.role, entityType)) return;
      const cleartext = await deps.vault.resolve(deps.sessionId, token);
      if (cleartext !== null) {
        resolved.set(token, cleartext);
      }
    }),
  );

  if (resolved.size === 0) {
    return cloned;
  }

  const replaceTokens = (text: string): string =>
    text.replace(TOKEN_RE, (match) => resolved.get(match) ?? match);

  for (const block of cloned.content) {
    if (block.type === 'text') {
      block.text = replaceTokens(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      block.input = walkAndReplace(block.input, replaceTokens);
      continue;
    }
    const maybeResult = block as { type: string; content?: unknown };
    if (maybeResult.type === 'tool_result' && maybeResult.content !== undefined) {
      maybeResult.content = walkAndReplace(maybeResult.content, replaceTokens);
    }
  }
  return cloned;
}

function parseEntityType(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  TOKEN_RE.lastIndex = 0;
  return m === null ? null : m[1] ?? null;
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
