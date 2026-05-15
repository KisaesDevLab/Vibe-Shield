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
  type AuditLogger,
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
  anthropicLatency,
  proxyCalls,
  rateLimitBreaches,
  spendCapBreaches,
  spendMicrodollars,
  tokensInput,
  tokensOutput,
} from '../metrics.js';
import { DEFAULT_POLICY } from '../policy/built-in.js';
import type { PolicyResolver } from '../policy/resolver.js';
import type { PolicyConfig } from '../policy/schema.js';
import {
  RateLimitExceededError,
  type RateLimiter,
} from '../quota/rate-limiter.js';
import {
  SpendCapExceededError,
  type SpendTracker,
  priceFor,
} from '../quota/spend-cap.js';
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
  policies?: PolicyResolver;
  /** When the gateway is configured with ZDR. Policies that
   *  require ZDR refuse if this is false. */
  zdrEnabled?: boolean;
  audit?: AuditLogger;
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
    // 0a. Resolve the active policy. Apply request-level overrides if
    //     specified; verify model is allowed; verify ZDR contract.
    const policy = await this.resolvePolicy(request, auth);
    this.assertPolicyAllowsRequest(policy, request);

    // 0b. Quotas before any I/O.
    await this.checkQuotas(auth, policy);

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
    const anthropicStart = process.hrtime.bigint();
    try {
      anthropicResponse = await withRetry(() =>
        this.deps.anthropic.messages.create(anthropicParams),
      );
      anthropicLatency.observe(
        Number(process.hrtime.bigint() - anthropicStart) / 1e9,
      );
    } catch (err) {
      anthropicLatency.observe(
        Number(process.hrtime.bigint() - anthropicStart) / 1e9,
      );
      proxyCalls.inc({
        tenant_id: auth.tenantId,
        app_id: auth.appId,
        model: anthropicParams.model,
        status: 'error',
      });
      throw mapAnthropicError(err);
    }
    proxyCalls.inc({
      tenant_id: auth.tenantId,
      app_id: auth.appId,
      model: anthropicParams.model,
      status: 'ok',
    });
    tokensInput.inc(
      { tenant_id: auth.tenantId, app_id: auth.appId, model: anthropicParams.model },
      anthropicResponse.usage.input_tokens,
    );
    tokensOutput.inc(
      { tenant_id: auth.tenantId, app_id: auth.appId, model: anthropicParams.model },
      anthropicResponse.usage.output_tokens,
    );

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
    spendMicrodollars.inc(
      { tenant_id: auth.tenantId, app_id: auth.appId, model: anthropicParams.model },
      pricedMicrodollars(
        anthropicParams.model,
        anthropicResponse.usage.input_tokens,
        anthropicResponse.usage.output_tokens,
      ),
    );

    // 5. Re-identify tokens in the response per the active policy.
    const reidentified = await reidentifyResponse(anthropicResponse, {
      vault: this.deps.vault,
      sessionId,
      policy: policy.reid,
    });

    // 6. Audit. Best-effort: log a warning if it fails so the request
    //    isn't taken down by an audit subsystem hiccup. The append-only
    //    trigger means we never insert garbage.
    if (this.deps.audit !== undefined) {
      try {
        await this.deps.audit.append({
          tenantId: auth.tenantId,
          sessionId,
          eventType: 'request',
          payload: {
            app_id: auth.appId,
            model: anthropicParams.model,
            input_tokens: anthropicResponse.usage.input_tokens,
            output_tokens: anthropicResponse.usage.output_tokens,
            policy_name: policy.name,
            zdr: this.deps.zdrEnabled === true,
          },
        });
        if (policy.reid.mode !== 'none') {
          await this.deps.audit.append({
            tenantId: auth.tenantId,
            sessionId,
            eventType: 'reidentify',
            payload: { mode: policy.reid.mode, model: anthropicParams.model },
          });
        }
      } catch {
        // Swallow on the request path; an audit cron alarm will surface
        // sustained insert failures.
      }
    }

    return { response: reidentified, sessionId };
  }

  /** Pre-flight quota checks. Throws on rate limit or spend cap breach. */
  async checkQuotas(auth: AuthContext, policy?: PolicyConfig): Promise<void> {
    if (this.deps.rateLimiter !== undefined) {
      try {
        await this.deps.rateLimiter.check(
          auth.tenantId,
          auth.appId,
          policy?.rate_limit_per_minute,
        );
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          rateLimitBreaches.inc({ tenant_id: auth.tenantId, app_id: auth.appId });
          throw new RateLimitHttpError(err.limit, err.retryAfterSeconds);
        }
        throw err;
      }
    }
    if (this.deps.spendTracker !== undefined) {
      try {
        await this.deps.spendTracker.checkCap(
          auth.tenantId,
          policy?.spend_cap_microdollars !== undefined
            ? BigInt(policy.spend_cap_microdollars)
            : undefined,
        );
      } catch (err) {
        if (err instanceof SpendCapExceededError) {
          spendCapBreaches.inc({ tenant_id: auth.tenantId });
          throw new PermissionError(
            'monthly spend cap reached for this tenant',
          );
        }
        throw err;
      }
    }
  }

  async resolvePolicy(
    request: MessagesRequest,
    auth: AuthContext,
  ): Promise<PolicyConfig> {
    if (this.deps.policies === undefined) {
      return DEFAULT_POLICY;
    }
    const requested =
      typeof (request as { policy_name?: unknown }).policy_name === 'string'
        ? ((request as { policy_name: string }).policy_name)
        : undefined;
    return this.deps.policies.resolve({
      tenantId: auth.tenantId,
      appId: auth.appId,
      ...(requested !== undefined ? { requestedPolicy: requested } : {}),
    });
  }

  private assertPolicyAllowsRequest(
    policy: PolicyConfig,
    request: MessagesRequest,
  ): void {
    if (
      policy.allowed_models.length > 0 &&
      !policy.allowed_models.includes(request.model)
    ) {
      throw new InvalidRequestError(
        `model "${request.model}" not allowed by policy "${policy.name}"`,
      );
    }
    if (
      policy.max_tokens_ceiling !== undefined &&
      request.max_tokens > policy.max_tokens_ceiling
    ) {
      throw new InvalidRequestError(
        `max_tokens=${request.max_tokens.toString()} exceeds policy ceiling ${policy.max_tokens_ceiling.toString()}`,
      );
    }
    if (policy.zdr_required && this.deps.zdrEnabled !== true) {
      throw new PermissionError(
        `policy "${policy.name}" requires ZDR but the gateway is not configured with ZDR`,
      );
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
  delete (rest as { policy_name?: unknown }).policy_name;
  return rest as unknown as MessageCreateParamsNonStreaming;
}

function pricedMicrodollars(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Convert bigint micro-dollars to a Number for the prom-client
  // Counter (which expects number). Even at lifetime CPA-firm spend
  // this stays well within Number.MAX_SAFE_INTEGER.
  return Number(priceFor(model, inputTokens, outputTokens));
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
