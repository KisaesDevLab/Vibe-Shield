/**
 * Proxy orchestrator — the end-to-end redact → call → re-identify
 * pipeline for /v1/messages.
 *
 * Fail-closed: any error mid-pipeline (engine down, Anthropic 4xx, DB
 * blip, rate limit, spend cap) propagates as a typed HttpError. We
 * never proceed with a partially-redacted request, never return a
 * partially-re-identified response, never fall back to "ship cleartext
 * to keep it working".
 */

import type {
  Message,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import {
  type ApiKeyStore,
  type SessionManager,
  type TokenVault,
} from '@kisaesdevlab/vibe-shield-schema';
import type { AnthropicMessagesClient } from '../anthropic/client.js';
import type { EngineClient } from '../engine/client.js';
import {
  EngineUnavailableError,
  HttpError,
  InvalidRequestError,
  PermissionError,
} from '../errors.js';
import type { AuthContext } from '../middleware/api-key.js';
import {
  RateLimitExceededError,
  type RateLimiter,
} from '../quota/rate-limiter.js';
import { SpendCapExceededError, type SpendTracker } from '../quota/spend-cap.js';
import type { MessagesRequest } from '../schemas/messages.js';
import { redactRequest } from './redactor.js';
import { reidentifyResponse } from './reidentifier.js';
import { withRetry } from './retry.js';

export interface OrchestratorDeps {
  engine: EngineClient;
  anthropic: AnthropicMessagesClient;
  vault: TokenVault;
  sessions: SessionManager;
  apiKeys: ApiKeyStore;
  defaultSessionTtlMinutes: number;
  rateLimiter?: RateLimiter;
  spendTracker?: SpendTracker;
}

export interface ProxyResult {
  response: Message;
  sessionId: string;
}

export class ProxyOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async handle(
    request: MessagesRequest,
    auth: AuthContext,
    correlationId: string | undefined,
  ): Promise<ProxyResult> {
    // 0. Quotas before any I/O. Reject before we waste an engine call.
    await this.checkQuotas(auth);

    // 1. Resolve / create session.
    const sessionId = await this.acquireSession(request, auth);

    // 2. Redact every cleartext field.
    let redacted;
    try {
      redacted = await redactRequest(request, {
        engine: this.deps.engine,
        vault: this.deps.vault,
        sessionId,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    } catch (err) {
      throw new EngineUnavailableError(
        err instanceof Error ? `redaction failed: ${err.name}` : 'redaction failed',
      );
    }

    // 3. Call Anthropic with retry/backoff on transient failures.
    const anthropicParams = redactedToAnthropicParams(redacted.request);
    let anthropicResponse: Message;
    try {
      anthropicResponse = await withRetry(() =>
        this.deps.anthropic.messages.create(anthropicParams),
      );
    } catch (err) {
      throw mapAnthropicError(err);
    }

    // 4. Record spend (before re-identify so a re-id failure doesn't
    //    drop the audit row for a call that already happened).
    if (this.deps.spendTracker !== undefined) {
      await this.deps.spendTracker.record({
        tenantId: auth.tenantId,
        appId: auth.appId,
        model: anthropicParams.model,
        inputTokens: anthropicResponse.usage.input_tokens,
        outputTokens: anthropicResponse.usage.output_tokens,
      });
    }

    // 5. Re-identify tokens in the response.
    const reidentified = await reidentifyResponse(anthropicResponse, {
      vault: this.deps.vault,
      sessionId,
    });

    return { response: reidentified, sessionId };
  }

  /** Pre-flight quota checks. Throws on rate limit or spend cap breach. */
  async checkQuotas(auth: AuthContext): Promise<void> {
    if (this.deps.rateLimiter !== undefined) {
      try {
        await this.deps.rateLimiter.check(auth.tenantId, auth.appId);
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          // Anthropic-shaped rate-limit envelope.
          throw new RateLimitHttpError(err.limit, err.retryAfterSeconds);
        }
        throw err;
      }
    }
    if (this.deps.spendTracker !== undefined) {
      try {
        await this.deps.spendTracker.checkCap(auth.tenantId);
      } catch (err) {
        if (err instanceof SpendCapExceededError) {
          throw new PermissionError(
            'monthly spend cap reached for this tenant',
          );
        }
        throw err;
      }
    }
  }

  async acquireSession(
    request: MessagesRequest,
    auth: AuthContext,
  ): Promise<string> {
    if (request.session_id !== undefined) {
      const existing = await this.deps.sessions.get(request.session_id);
      if (existing === null) {
        throw new InvalidRequestError('session_id not found');
      }
      if (existing.tenantId !== auth.tenantId) {
        throw new InvalidRequestError('session_id not found');
      }
      return existing.id;
    }
    const ephemeral = await this.deps.sessions.create({
      tenantId: auth.tenantId,
      appId: auth.appId,
      userId: 'ephemeral',
      ttlMinutes: this.deps.defaultSessionTtlMinutes,
    });
    return ephemeral.id;
  }

  /** Used by the streaming path. */
  redactForUpstream(
    request: MessagesRequest,
    sessionId: string,
    correlationId?: string,
  ): Promise<{ params: MessageCreateParamsNonStreaming }> {
    return (async () => {
      const redacted = await redactRequest(request, {
        engine: this.deps.engine,
        vault: this.deps.vault,
        sessionId,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
      return { params: redactedToAnthropicParams(redacted.request) };
    })();
  }
}

class RateLimitHttpError extends HttpError {
  constructor(
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(429, 'rate_limit_error', `rate limit exceeded: ${limit.toString()}/min`);
    this.name = 'RateLimitHttpError';
  }
}

function redactedToAnthropicParams(req: MessagesRequest): MessageCreateParamsNonStreaming {
  const rest = { ...req };
  delete (rest as { session_id?: unknown }).session_id;
  delete (rest as { stream?: unknown }).stream;
  return rest as unknown as MessageCreateParamsNonStreaming;
}

function mapAnthropicError(err: unknown): Error {
  const e = err as { status?: number; message?: string };
  if (typeof e.status === 'number') {
    if (e.status >= 500) {
      return new EngineUnavailableError('upstream model error');
    }
    return new InvalidRequestError(
      `Anthropic rejected the request (status ${e.status.toString()})`,
    );
  }
  return new EngineUnavailableError('Anthropic call failed');
}
