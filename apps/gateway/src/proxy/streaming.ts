/**
 * Streaming proxy.
 *
 * Anthropic streams Server-Sent Events (SSE). For the proxy:
 *
 *   1. Open a streaming call to Anthropic with the redacted request.
 *   2. Buffer text_delta events until we have either a complete token
 *      span (``<ENTITY_N>``) or a chunk that's safely past any token
 *      boundary; flush re-identified text to the client SSE stream.
 *   3. Pass through non-text events (message_start, content_block_start,
 *      message_stop, etc.) untouched.
 *
 * Why buffer at all: Anthropic may send a token in pieces — first
 * ``<EM``, then ``AIL_ADDRESS_1>``. Re-identifying mid-token would emit
 * the literal ``<EM`` to the client, defeating the whole point.
 *
 * The buffer holds the *trailing* unflushed portion of the current text
 * block. If the trailing characters could be the start of a token
 * (i.e. contain ``<`` without a closing ``>``), we hold them. Otherwise
 * we flush.
 */

import type { Response } from 'express';
import type { TokenVault } from '@kisaesdevlab/vibe-shield-schema';
import type Anthropic from '@anthropic-ai/sdk';

const TOKEN_RE = /<([A-Z][A-Z_]*?)_(\d+)>/g;

export interface StreamingDeps {
  /**
   * Live accessor for the raw SDK. Phase 23.5: rotation-aware so a key
   * swap is picked up on the next stream call.
   */
  getAnthropic: () => Anthropic;
  vault: TokenVault;
  sessionId: string;
}

interface RawStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  index?: number;
}

export async function streamProxy(
  res: Response,
  params: Anthropic.MessageCreateParamsStreaming,
  deps: StreamingDeps,
): Promise<void> {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  // Per-content-block trailing buffers. Anthropic may interleave
  // multiple content blocks; index into the array by event.index.
  const trailing = new Map<number, string>();
  // Resolved-token cache so each token only hits the vault once even
  // if it shows up in many deltas.
  const resolved = new Map<string, string>();

  const tryResolveToken = async (token: string): Promise<string> => {
    const cached = resolved.get(token);
    if (cached !== undefined) return cached;
    const ct = await deps.vault.resolve(deps.sessionId, token);
    const out = ct ?? token;
    resolved.set(token, out);
    return out;
  };

  const replaceTokens = async (text: string): Promise<string> => {
    if (!text.includes('<')) return text;
    const matches = Array.from(text.matchAll(TOKEN_RE));
    if (matches.length === 0) return text;
    let result = '';
    let cursor = 0;
    for (const m of matches) {
      const idx = m.index ?? 0;
      result += text.slice(cursor, idx);
      result += await tryResolveToken(m[0]);
      cursor = idx + m[0].length;
    }
    result += text.slice(cursor);
    return result;
  };

  const emit = (event: { type?: string; data: unknown }): void => {
    if (event.type !== undefined) {
      res.write(`event: ${event.type}\n`);
    }
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

  try {
    const stream = await deps.getAnthropic().messages.stream(params);
    for await (const event of stream as AsyncIterable<RawStreamEvent>) {
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
      ) {
        const idx = event.index ?? 0;
        const buffered = (trailing.get(idx) ?? '') + event.delta.text;
        // Find the safe flush boundary: the last char that can't be
        // part of an in-progress token. A `<` opens a candidate token
        // span; we hold from there until a `>` arrives.
        const lastOpen = buffered.lastIndexOf('<');
        const lastClose = buffered.lastIndexOf('>');
        let flushable: string;
        let hold: string;
        if (lastOpen > lastClose) {
          flushable = buffered.slice(0, lastOpen);
          hold = buffered.slice(lastOpen);
        } else {
          flushable = buffered;
          hold = '';
        }
        trailing.set(idx, hold);
        if (flushable.length > 0) {
          const reidentified = await replaceTokens(flushable);
          emit({
            type: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'text_delta', text: reidentified },
            },
          });
        }
        continue;
      }
      if (event.type === 'content_block_stop') {
        // Flush the held trailing buffer for this block.
        const idx = event.index ?? 0;
        const hold = trailing.get(idx);
        if (hold !== undefined && hold.length > 0) {
          const reidentified = await replaceTokens(hold);
          emit({
            type: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'text_delta', text: reidentified },
            },
          });
          trailing.delete(idx);
        }
      }
      // Non-text events pass through verbatim — they carry no PII.
      if (event.type !== undefined) {
        emit({ type: event.type, data: event });
      }
    }
    res.end();
  } catch (err) {
    // Once headers are sent we can't change status; emit a final SSE
    // event with the error and close. Pre-headers errors propagate
    // to the regular error handler.
    if (res.headersSent) {
      const e = err as { status?: number; message?: string };
      emit({
        type: 'error',
        data: {
          type: 'error',
          error: { type: 'api_error', message: 'upstream stream failed' },
          status: e.status ?? 500,
        },
      });
      res.end();
      return;
    }
    throw err;
  }
}
