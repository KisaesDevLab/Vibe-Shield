/**
 * Proxy orchestrator — the end-to-end redact → call → re-identify
 * pipeline for /v1/messages.
 *
 * Fail-closed: any error mid-pipeline (engine down, Anthropic 4xx, DB
 * blip) propagates as a typed HttpError. We never proceed with a
 * partially-redacted request, never return a partially-re-identified
 * response, never fall back to "ship cleartext to keep it working".
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
  InvalidRequestError,
} from '../errors.js';
import type { AuthContext } from '../middleware/api-key.js';
import type { MessagesRequest } from '../schemas/messages.js';
import { redactRequest } from './redactor.js';
import { reidentifyResponse } from './reidentifier.js';

export interface OrchestratorDeps {
  engine: EngineClient;
  anthropic: AnthropicMessagesClient;
  vault: TokenVault;
  sessions: SessionManager;
  apiKeys: ApiKeyStore;
  defaultSessionTtlMinutes: number;
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
    // 1. Resolve / create session. If the request supplied a
    //    ``session_id`` we honor it; otherwise open an ephemeral
    //    session for this single request.
    const sessionId = await this.acquireSession(request, auth);

    // 2. Redact every cleartext field. The engine is the only place
    //    cleartext PII flows during this pipeline.
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

    // 3. Call Anthropic with the redacted request.
    const anthropicParams = redactedToAnthropicParams(redacted.request);
    let anthropicResponse: Message;
    try {
      anthropicResponse = await this.deps.anthropic.messages.create(anthropicParams);
    } catch (err) {
      throw mapAnthropicError(err);
    }

    // 4. Re-identify tokens in the response.
    const reidentified = await reidentifyResponse(anthropicResponse, {
      vault: this.deps.vault,
      sessionId,
    });

    return { response: reidentified, sessionId };
  }

  private async acquireSession(
    request: MessagesRequest,
    auth: AuthContext,
  ): Promise<string> {
    if (request.session_id !== undefined) {
      const existing = await this.deps.sessions.get(request.session_id);
      if (existing === null) {
        throw new InvalidRequestError('session_id not found');
      }
      if (existing.tenantId !== auth.tenantId) {
        // Surface as 404-shaped to avoid leaking the existence of a
        // session that belongs to another tenant.
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
}

/**
 * Convert our validated Zod request into the Anthropic SDK's typed
 * params. The shapes overlap heavily; we treat the SDK's type as the
 * authoritative one and cast at the boundary.
 */
function redactedToAnthropicParams(req: MessagesRequest): MessageCreateParamsNonStreaming {
  // Strip Vibe-Shield-only fields and the streaming flag (Phase 8b).
  const rest = { ...req };
  delete (rest as { session_id?: unknown }).session_id;
  delete (rest as { stream?: unknown }).stream;
  return rest as unknown as MessageCreateParamsNonStreaming;
}

function mapAnthropicError(err: unknown): Error {
  const e = err as { status?: number; message?: string };
  // Anthropic SDK errors carry .status; our error envelope mirrors the
  // upstream type so the client sees a consistent shape.
  // Phase 8b will add retry/backoff for transient 5xx; for now we
  // surface them as-is.
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
