/**
 * End-to-end proxy test: SSN + name + email in the request body must
 * not appear in the redacted payload that hits Anthropic, and the
 * stubbed response's tokens must come back as cleartext on the wire.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ApiKeyStore,
  type DatabaseHandle,
} from '@kisaesdevlab/vibe-shield-schema';
import type { Message } from '@anthropic-ai/sdk/resources/messages.mjs';
import {
  buildTestApp,
  emptyMessage,
  freshDatabase,
  integrationEnabled,
  stubAnthropic,
  type StubAnthropic,
} from './setup.js';

function messageWithText(text: string): Message {
  const m = emptyMessage();
  (m.content as { type: 'text'; text: string }[])[0]!.text = text;
  return m;
}

describe.skipIf(!integrationEnabled)('POST /v1/messages — end-to-end proxy', () => {
  let handle: DatabaseHandle;
  let key: string;
  let anthropic: StubAnthropic;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    handle = await freshDatabase();
    const issued = await new ApiKeyStore(handle.db).issue({
      tenantId: 'acme',
      appId: 'mybooks',
      name: 'proxy-test',
    });
    key = issued.key;
    anthropic = stubAnthropic(messageWithText("ok, I'll handle <PERSON_1>'s case"));
    app = buildTestApp({ handle, anthropic });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('strips PII from request before Anthropic, re-identifies response', async () => {
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'My client Jane Doe at jane.doe@example.com — SSN 234-56-7890. Help me categorize.',
          },
        ],
      });

    expect(r.status).toBe(200);
    expect(r.headers['vs-session-id']).toMatch(/^[0-9a-f-]{36}$/);

    // 1. Request to Anthropic (recorded by the stub) had tokens, not PII.
    const params = anthropic.recorded.lastParams as { messages: { content: string }[] };
    const sentText = params.messages[0]!.content;
    expect(sentText).not.toContain('Jane Doe');
    expect(sentText).not.toContain('234-56-7890');
    expect(sentText).not.toContain('jane.doe@example.com');
    expect(sentText).toContain('<PERSON_');
    expect(sentText).toContain('<US_SSN_');
    expect(sentText).toContain('<EMAIL_ADDRESS_');

    // 2. Response to client had PII re-identified.
    expect(r.body.content[0].text).toContain('Jane Doe');
    expect(r.body.content[0].text).not.toContain('<PERSON_');
  });

  it('redacts the system prompt the same way as user content', async () => {
    anthropic.recorded.lastParams = undefined;
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        system: 'Client context: Jane Doe, SSN 234-56-7890.',
        messages: [{ role: 'user', content: 'Hi' }],
      });
    expect(r.status).toBe(200);
    const params = anthropic.recorded.lastParams as { system: string };
    expect(params.system).not.toContain('Jane Doe');
    expect(params.system).not.toContain('234-56-7890');
    expect(params.system).toContain('<PERSON_');
    expect(params.system).toContain('<US_SSN_');
  });

  it('redacts tool_use.input recursively', async () => {
    anthropic.recorded.lastParams = undefined;
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Calling tool.' },
              {
                type: 'tool_use',
                id: 'tool_1',
                name: 'lookup_customer',
                input: {
                  search: 'Jane Doe',
                  filters: { email: 'jane.doe@example.com' },
                  notes: ['SSN 234-56-7890'],
                },
              },
            ],
          },
        ],
      });
    expect(r.status).toBe(200);
    const sent = JSON.stringify(anthropic.recorded.lastParams);
    expect(sent).not.toContain('Jane Doe');
    expect(sent).not.toContain('234-56-7890');
    expect(sent).not.toContain('jane.doe@example.com');
  });

  it('returns 401 without auth', async () => {
    const r = await request(app)
      .post('/v1/messages')
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(r.status).toBe(401);
  });

  it('returns 501 for stream=true when no anthropicSdk wired', async () => {
    // Test app intentionally omits anthropicSdk; streaming requires
    // the real SDK because we need its typed stream() method.
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(r.status).toBe(501);
    expect(r.body.error.message).toContain('streaming not configured');
  });
});

describe.skipIf(!integrationEnabled)('Anthropic error mapping', () => {
  let handle: DatabaseHandle;
  let key: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    const issued = await new ApiKeyStore(handle.db).issue({
      tenantId: 'acme',
      appId: 'mybooks',
      name: 'err-test',
    });
    key = issued.key;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('maps Anthropic 4xx to invalid_request_error', async () => {
    const failingAnthropic: StubAnthropic = {
      recorded: { lastParams: undefined },
      models: { list: () => Promise.resolve({ data: [] }) },
      messages: {
        create: () => {
          const e = new Error('rate limit') as Error & { status?: number };
          e.status = 429;
          return Promise.reject(e);
        },
      },
    };
    const app = buildTestApp({ handle, anthropic: failingAnthropic });
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe('invalid_request_error');
  });

  it('maps Anthropic 5xx to engine_unavailable (503)', async () => {
    const failingAnthropic: StubAnthropic = {
      recorded: { lastParams: undefined },
      models: { list: () => Promise.resolve({ data: [] }) },
      messages: {
        create: () => {
          const e = new Error('upstream') as Error & { status?: number };
          e.status = 502;
          return Promise.reject(e);
        },
      },
    };
    const app = buildTestApp({ handle, anthropic: failingAnthropic });
    const r = await request(app)
      .post('/v1/messages')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(r.status).toBe(503);
  });
});
