/**
 * @kisaesdevlab/vibe-shield-client
 *
 * Drop-in replacement for `@anthropic-ai/sdk`. Mirrors the same
 * Messages API surface so a Vibe app's existing code keeps working
 * after the import swap:
 *
 *   - import Anthropic from "@anthropic-ai/sdk";
 *   + import VibeShield from "@kisaesdevlab/vibe-shield-client";
 *
 *   - const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   + const vs = new VibeShield({
 *   +     baseURL: process.env.VIBE_SHIELD_URL,
 *   +     apiKey: process.env.VIBE_SHIELD_KEY,  // vs_live_...
 *   +   });
 *
 *   await anthropic.messages.create({ ... });   // ↓
 *   await vs.messages.create({ ... });          // identical args + return shape
 *
 * The SDK never talks to Anthropic directly — every call hits the
 * gateway, which redacts → calls Anthropic → re-identifies.
 *
 * Hard rule #2 enforcement: this client must NEVER be imported by the
 * gateway itself. The CI lint rule `no-anthropic-direct` (Phase 20)
 * forbids `@anthropic-ai/sdk` imports outside of `apps/gateway/`.
 */

import type {
  Message,
  MessageCreateParams,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages.mjs';

export class VibeShieldError extends Error {
  override readonly name = 'VibeShieldError';
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

export class VibeShieldUnavailableError extends Error {
  override readonly name = 'VibeShieldUnavailableError';
}

export interface VibeShieldOptions {
  baseURL: string;
  apiKey: string;
  /** Default per-request timeout in ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Hook for callers to receive redaction telemetry per call. */
  onTelemetry?: (event: TelemetryEvent) => void;
}

export interface TelemetryEvent {
  /** Vibe Shield session ID returned in `vs-session-id` header. */
  sessionId: string;
  /** Status from the gateway. */
  status: number;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
}

interface MessagesResource {
  create(params: MessageCreateParamsNonStreaming): Promise<Message>;
  create(params: MessageCreateParamsStreaming): AsyncIterable<MessageStreamEvent>;
  create(
    params: MessageCreateParams,
  ): Promise<Message> | AsyncIterable<MessageStreamEvent>;
}

export class VibeShield {
  readonly messages: MessagesResource;

  constructor(private readonly options: VibeShieldOptions) {
    this.messages = {
      create: ((params: MessageCreateParams) => {
        if ('stream' in params && params.stream === true) {
          return this.createStream(params as MessageCreateParamsStreaming);
        }
        return this.createNonStreaming(params as MessageCreateParamsNonStreaming);
      }) as MessagesResource['create'],
    };
  }

  private async createNonStreaming(
    params: MessageCreateParamsNonStreaming,
  ): Promise<Message> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const start = Date.now();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await fetchImpl(`${stripSlash(this.options.baseURL)}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(params),
        signal: ctl.signal,
      });
      const elapsed = Date.now() - start;
      if (!res.ok) {
        throw await this.toError(res);
      }
      const body = (await res.json()) as Message;
      const sessionId = res.headers.get('vs-session-id') ?? '';
      this.options.onTelemetry?.({ sessionId, status: res.status, latencyMs: elapsed });
      return body;
    } catch (err) {
      if (err instanceof VibeShieldError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new VibeShieldUnavailableError('gateway timed out');
      }
      throw new VibeShieldUnavailableError(
        err instanceof Error ? err.message : 'gateway unreachable',
      );
    } finally {
      clearTimeout(t);
    }
  }

  private async *createStream(
    params: MessageCreateParamsStreaming,
  ): AsyncIterable<MessageStreamEvent> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(`${stripSlash(this.options.baseURL)}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(params),
    });
    if (!res.ok || res.body === null) {
      throw await this.toError(res);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events separated by blank line.
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const ev = parseSseEvent(raw);
        if (ev !== null) {
          yield ev as MessageStreamEvent;
        }
      }
    }
  }

  private async toError(res: Response): Promise<VibeShieldError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    const env = body as { error?: { type?: string; message?: string } };
    return new VibeShieldError(
      res.status,
      env.error?.type ?? 'api_error',
      env.error?.message ?? `gateway returned ${res.status.toString()}`,
    );
  }
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function parseSseEvent(raw: string): unknown {
  let data: string | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      data = (data ?? '') + line.slice(5).trim();
    }
  }
  if (data === null) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export default VibeShield;
