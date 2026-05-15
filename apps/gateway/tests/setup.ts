import {
  ApiKeyStore,
  SessionManager,
  TokenVault,
  type TenantKeyResolver,
  createDatabase,
  type DatabaseHandle,
  newKey,
  runMigrations,
} from '@kisaesdevlab/vibe-shield-schema';
import type { Message } from '@anthropic-ai/sdk/resources/messages.mjs';
import pino, { type Logger } from 'pino';
import { createApp } from '../src/app.js';
import type { AnthropicMessagesClient } from '../src/anthropic/client.js';
import { EngineClient } from '../src/engine/client.js';

export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? process.env['VIBE_SHIELD_DATABASE_URL'];

export const integrationEnabled =
  DATABASE_URL !== undefined && DATABASE_URL !== '';

export async function freshDatabase(): Promise<DatabaseHandle> {
  if (!integrationEnabled || DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL not set');
  }
  const handle = createDatabase(DATABASE_URL, { max: 5 });
  await runMigrations(handle, { fresh: true });
  return handle;
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Static in-memory key resolver — same one used by schema tests. */
export class StaticKeyResolver implements TenantKeyResolver {
  private readonly keys = new Map<string, Buffer>();
  resolve(tenantId: string): Promise<Buffer> {
    const existing = this.keys.get(tenantId);
    if (existing !== undefined) return Promise.resolve(existing);
    const fresh = newKey();
    this.keys.set(tenantId, fresh);
    return Promise.resolve(fresh);
  }
}

/**
 * Stub Anthropic client. Tests inject canned responses; the recorder
 * captures the params the orchestrator sends upstream so we can assert
 * the request that *would have* hit the wire was redacted.
 */
export interface StubAnthropic extends AnthropicMessagesClient {
  recorded: { lastParams: unknown };
}

export function stubAnthropic(canned: Message): StubAnthropic {
  const recorded = { lastParams: undefined as unknown };
  return {
    recorded,
    models: {
      list: () => Promise.resolve({ data: [] }),
    },
    messages: {
      create: (params) => {
        recorded.lastParams = params;
        return Promise.resolve(canned);
      },
    },
  };
}

/**
 * Stub engine client. Replaces every email-shaped substring with
 * <EMAIL_ADDRESS_1>, every SSN-shaped with <US_SSN_1>, every Jane Doe
 * with <PERSON_1> — enough to drive the redactor without spinning up
 * the real Python engine.
 */
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const NAME_RE = /\bJane Doe\b/g;

export function stubEngine(): EngineClient {
  return {
    async redact(text: string) {
      let counter = 1;
      const tokens: { token: string; entity_type: string; cleartext: string }[] = [];
      const seen = new Map<string, string>();
      const rewrite = (re: RegExp, entityType: string, str: string): string =>
        str.replace(re, (match) => {
          const existing = seen.get(`${entityType}:${match}`);
          if (existing !== undefined) return existing;
          const tok = `<${entityType}_${counter.toString()}>`;
          counter += 1;
          seen.set(`${entityType}:${match}`, tok);
          tokens.push({ token: tok, entity_type: entityType, cleartext: match });
          return tok;
        });
      let out = rewrite(EMAIL_RE, 'EMAIL_ADDRESS', text);
      out = rewrite(SSN_RE, 'US_SSN', out);
      out = rewrite(NAME_RE, 'PERSON', out);
      return Promise.resolve({ redacted_text: out, spans: [], tokens });
    },
    async analyze() {
      return Promise.resolve({ results: [] });
    },
    async health() {
      return Promise.resolve({ status: 'ok', model_loaded: true });
    },
  } as unknown as EngineClient;
}

export function buildTestApp(deps: {
  handle: DatabaseHandle;
  apiKeys?: ApiKeyStore;
  sessions?: SessionManager;
  vault?: TokenVault;
  engine?: EngineClient;
  anthropic?: AnthropicMessagesClient;
}) {
  const apiKeys = deps.apiKeys ?? new ApiKeyStore(deps.handle.db);
  const sessions = deps.sessions ?? new SessionManager(deps.handle.db);
  const vault = deps.vault ?? new TokenVault(deps.handle.db, new StaticKeyResolver());
  const engine = deps.engine ?? stubEngine();
  const anthropic = deps.anthropic ?? stubAnthropic(emptyMessage());
  return createApp({
    db: deps.handle.db,
    apiKeys,
    sessions,
    vault,
    engine,
    anthropic,
    logger: silentLogger(),
    maxRequestBytes: 64 * 1024,
    sessionTtlMinutes: 60,
  });
}

export function emptyMessage(): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as unknown as Message;
}
