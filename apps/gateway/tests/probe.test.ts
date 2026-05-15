import { describe, expect, it } from 'vitest';
import {
  AnthropicUnreachableError,
  ConsumerKeyError,
  probeAnthropicKey,
} from '../src/anthropic/probe.js';

function fakeFetch(status: number, body: unknown = { data: [] }): typeof fetch {
  return async (input: unknown): Promise<Response> => {
    void input;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

describe('probeAnthropicKey', () => {
  it('returns model list on 200', async () => {
    const result = await probeAnthropicKey({
      apiKey: 'sk-ant-...',
      fetchImpl: fakeFetch(200, {
        data: [{ id: 'claude-3-5-sonnet-20241022' }, { id: 'claude-3-5-haiku-20241022' }],
      }),
    });
    expect(result.models).toEqual([
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ]);
  });

  it('throws ConsumerKeyError on 401', async () => {
    await expect(
      probeAnthropicKey({
        apiKey: 'sk-bad',
        fetchImpl: fakeFetch(401),
      }),
    ).rejects.toBeInstanceOf(ConsumerKeyError);
  });

  it('throws ConsumerKeyError on 403', async () => {
    await expect(
      probeAnthropicKey({
        apiKey: 'sk-bad',
        fetchImpl: fakeFetch(403),
      }),
    ).rejects.toBeInstanceOf(ConsumerKeyError);
  });

  it('throws AnthropicUnreachableError on 5xx', async () => {
    await expect(
      probeAnthropicKey({
        apiKey: 'sk-ok',
        fetchImpl: fakeFetch(502),
      }),
    ).rejects.toBeInstanceOf(AnthropicUnreachableError);
  });

  it('throws AnthropicUnreachableError on network failure', async () => {
    await expect(
      probeAnthropicKey({
        apiKey: 'sk-ok',
        fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
    ).rejects.toBeInstanceOf(AnthropicUnreachableError);
  });

  it('error messages do not echo the API key', async () => {
    try {
      await probeAnthropicKey({
        apiKey: 'sk-ant-secret-do-not-leak',
        fetchImpl: fakeFetch(401),
      });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-ant-secret-do-not-leak');
    }
  });
});
