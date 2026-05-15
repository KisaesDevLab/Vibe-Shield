/**
 * Thin HTTP client for the Python redaction engine.
 *
 * The engine is internal-only — only the gateway calls it, on the
 * appliance's Docker network. We use plain ``fetch`` rather than
 * a generated client because the surface is tiny (3 endpoints) and the
 * upstream is owned in this monorepo.
 *
 * Hard rule #1: cleartext text traveling to the engine is necessary
 * (the engine *needs* it to redact). The engine never echoes it back —
 * only the redacted text + token map. We do not log the request body
 * on either side.
 */

export class EngineUnreachableError extends Error {
  override readonly name = 'EngineUnreachableError';
}

export class EngineFailureError extends Error {
  override readonly name = 'EngineFailureError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface EngineSpan {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface EngineTokenEntry {
  token: string;
  entity_type: string;
  cleartext: string;
}

export interface RedactResponse {
  redacted_text: string;
  spans: EngineSpan[];
  tokens: EngineTokenEntry[];
}

export interface AnalyzeResponse {
  results: EngineSpan[];
}

export interface EngineClientOptions {
  baseUrl: string;
  /** Per-call timeout in ms; default 30s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EngineClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async redact(
    text: string,
    correlationId?: string,
  ): Promise<RedactResponse> {
    return this.post<RedactResponse>('/redact', { text }, correlationId);
  }

  async analyze(
    text: string,
    correlationId?: string,
  ): Promise<AnalyzeResponse> {
    return this.post<AnalyzeResponse>('/analyze', { text }, correlationId);
  }

  async health(): Promise<{ status: string; model_loaded: boolean }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: ctl.signal,
      });
      if (!res.ok) {
        throw new EngineFailureError(`engine /health returned ${res.status.toString()}`, res.status);
      }
      return (await res.json()) as { status: string; model_loaded: boolean };
    } catch (err) {
      if (err instanceof EngineFailureError) throw err;
      throw new EngineUnreachableError(
        err instanceof Error ? err.message : 'unknown',
      );
    } finally {
      clearTimeout(t);
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    correlationId?: string,
  ): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (correlationId !== undefined) {
        headers['x-correlation-id'] = correlationId;
      }
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // Engine returns sanitized envelopes; we don't propagate any
        // body content into our logs. Just keep the status.
        throw new EngineFailureError(`engine ${path} returned ${res.status.toString()}`, res.status);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof EngineFailureError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EngineUnreachableError(`engine ${path} timed out after ${this.timeoutMs.toString()}ms`);
      }
      throw new EngineUnreachableError(
        err instanceof Error ? err.message : 'unknown',
      );
    } finally {
      clearTimeout(t);
    }
  }
}
