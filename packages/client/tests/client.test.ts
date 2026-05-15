import { describe, expect, it, vi } from 'vitest';
import {
  VibeShield,
  VibeShieldUnavailableError,
} from '../src/index.js';

const cannedMessage = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function ok(body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

function err(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('VibeShield SDK', () => {
  it('non-streaming create returns the gateway response', async () => {
    const vs = new VibeShield({
      baseURL: 'http://gw',
      apiKey: 'vs_live_test',
      fetchImpl: ok(cannedMessage),
    });
    const result = await vs.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok' });
  });

  it('puts the API key on Authorization: Bearer', async () => {
    let capturedHeader: string | null = null;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      capturedHeader = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify(cannedMessage), { status: 200 });
    }) as typeof fetch;
    const vs = new VibeShield({
      baseURL: 'http://gw',
      apiKey: 'vs_live_secret',
      fetchImpl,
    });
    await vs.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(capturedHeader).toBe('Bearer vs_live_secret');
  });

  it('emits telemetry with vs-session-id', async () => {
    const onTelemetry = vi.fn();
    const vs = new VibeShield({
      baseURL: 'http://gw',
      apiKey: 'vs_live_test',
      fetchImpl: ok(cannedMessage, { 'vs-session-id': 'abc-123' }),
      onTelemetry,
    });
    await vs.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'abc-123', status: 200 }),
    );
  });

  it('throws VibeShieldError on 4xx with parsed envelope', async () => {
    const vs = new VibeShield({
      baseURL: 'http://gw',
      apiKey: 'vs_live_test',
      fetchImpl: err(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad model' },
      }),
    });
    await expect(
      vs.messages.create({
        model: 'no-such-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({
      name: 'VibeShieldError',
      status: 400,
      type: 'invalid_request_error',
    });
  });

  it('throws VibeShieldUnavailableError on network failure', async () => {
    const vs = new VibeShield({
      baseURL: 'http://gw',
      apiKey: 'vs_live_test',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(
      vs.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(VibeShieldUnavailableError);
  });
});
