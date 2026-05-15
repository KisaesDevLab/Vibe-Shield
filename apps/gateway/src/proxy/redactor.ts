/**
 * Request redactor.
 *
 * Walks the Anthropic Messages API request and replaces every cleartext
 * string with deterministic vault tokens. Operates in three places:
 *
 *   1. Every ``user`` / ``assistant`` message's ``content`` — string
 *      form is redacted directly; array form has each ``text`` block's
 *      text redacted, ``tool_use.input`` recursively walked.
 *   2. The top-level ``system`` field — clients often paste customer
 *      context here.
 *   3. Tool ``input`` JSON — recursively walked, every string value
 *      redacted; non-string values left alone (numbers, booleans
 *      cannot leak PII).
 *
 * Side effect: every cleartext fragment flows through
 * ``TokenVault.allocate`` so the tokens chosen here resolve back to
 * cleartext via the same vault on the response path.
 *
 * Tool ``input`` is documented as "an object" by Anthropic but
 * effectively free JSON — we walk it generically.
 */

import type {
  RecognizerMissInput,
  TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import type { EngineClient, EngineMissEntry } from '../engine/client.js';
import type { MessagesRequest } from '../schemas/messages.js';

const TEXT_ENTITY = 'TEXT' as const;

export interface RedactedRequest {
  request: MessagesRequest;
  /** Every cleartext → token mapping allocated for this request. */
  allocations: Array<{ token: string; cleartext: string; entity_type: string }>;
  /** Backstop misses surfaced by the engine. Caller persists to vs_recognizer_misses. */
  misses: RecognizerMissInput[];
}

export interface RedactorDeps {
  engine: EngineClient;
  vault: TokenVault;
  sessionId: string;
  correlationId?: string;
}

/**
 * Redact every cleartext field in ``request``. Returns a deep-cloned
 * request — the caller's original is left untouched.
 */
export async function redactRequest(
  request: MessagesRequest,
  deps: RedactorDeps,
): Promise<RedactedRequest> {
  const allocations: RedactedRequest['allocations'] = [];
  const misses: RecognizerMissInput[] = [];

  const redactString = async (text: string): Promise<string> => {
    if (text.length === 0) {
      return text;
    }
    const result = await deps.engine.redact(text, deps.correlationId);
    if (result.misses !== undefined) {
      for (const m of result.misses) {
        misses.push(toMissInput(m));
      }
    }
    if (result.tokens.length === 0) {
      return result.redacted_text;
    }
    // The engine returns a per-request tokenizer's output. We mint
    // session-persistent tokens through the vault so the *same*
    // cleartext appearing later in this session reuses the same token.
    let redacted = result.redacted_text;
    for (const entry of result.tokens) {
      const alloc = await deps.vault.allocate(
        deps.sessionId,
        entry.entity_type,
        entry.cleartext,
      );
      // Engine's per-request token (e.g. <EMAIL_ADDRESS_1>) → vault's
      // session-stable token. We do a literal string replace in the
      // redacted text. Engine tokens are unique within the request,
      // so a single replace per token is safe.
      redacted = redacted.split(entry.token).join(alloc.token);
      allocations.push({
        token: alloc.token,
        cleartext: entry.cleartext,
        entity_type: entry.entity_type,
      });
    }
    return redacted;
  };

  // Walk arbitrary JSON inside a tool_use.input, redacting strings.
  const redactJsonStrings = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        out.push(await redactJsonStrings(item));
      }
      return out;
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = await redactJsonStrings(v);
      }
      return out;
    }
    return value;
  };

  // Deep-clone the request via JSON round-trip so we don't mutate the
  // caller's object. Content payloads here are still cleartext at this
  // point — never logged, never persisted.
  const cloned: MessagesRequest = JSON.parse(JSON.stringify(request)) as MessagesRequest;

  if (cloned.system !== undefined) {
    if (typeof cloned.system === 'string') {
      cloned.system = await redactString(cloned.system);
    } else {
      for (const block of cloned.system) {
        block.text = await redactString(block.text);
      }
    }
  }

  for (const message of cloned.messages) {
    if (typeof message.content === 'string') {
      message.content = await redactString(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        block.text = await redactString(block.text);
        continue;
      }
      if (block.type === 'tool_use') {
        block.input = await redactJsonStrings(block.input);
        continue;
      }
      if (block.type === 'tool_result') {
        // tool_result.content from a Vibe app may carry tool output
        // that contains PII (e.g. a CSV row pulled from MyBooks).
        const tr = block as { content?: unknown };
        if (typeof tr.content === 'string') {
          tr.content = await redactString(tr.content);
        } else if (Array.isArray(tr.content)) {
          tr.content = await redactJsonStrings(tr.content);
        }
      }
      // image blocks pass through untouched — image redaction is Phase 17.
    }
  }

  return { request: cloned, allocations, misses };
}

function toMissInput(m: EngineMissEntry): RecognizerMissInput {
  return {
    pattern: m.backstop_name,
    sampleHash: m.sample_hash,
    severity: m.severity,
  };
}

export { TEXT_ENTITY };
