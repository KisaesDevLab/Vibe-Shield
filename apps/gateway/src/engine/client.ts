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

export interface EngineMissEntry {
  entity_type: string;
  backstop_name: string;
  severity: string;
  sample_hash: string;
  span_start: number;
  span_end: number;
}

export interface RedactResponse {
  redacted_text: string;
  spans: EngineSpan[];
  tokens: EngineTokenEntry[];
  /** Backstop catches Presidio missed; v1.0.1+. Optional for
   *  backward compatibility with pre-1.0.1 engine builds. */
  misses?: EngineMissEntry[];
}

/** Phase 17 — image redaction. Per-region bbox metadata + a masked PNG. */
export interface EngineMaskedRegion {
  entity_type: string;
  token?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}

export interface RedactImageResponse {
  image_sha256: string;
  masked_image_sha256: string;
  /** base64-encoded PNG of the masked image. */
  masked_image_base64: string;
  /** OCR'd text after redaction (tokens substituted in). */
  redacted_text: string;
  tokens: EngineTokenEntry[];
  masked_regions: EngineMaskedRegion[];
}

/** v1.5 — per-page entry from /redact-pdf. */
export interface RedactPdfPage {
  page_number: number;
  total_pages?: number;
  masked_image_sha256: string;
  masked_image_base64: string;
  redacted_text: string;
  tokens: EngineTokenEntry[];
  masked_regions: EngineMaskedRegion[];
}

export interface RedactPdfSummary {
  pdf_sha256: string;
  pages_count: number;
  tokens_concatenated: EngineTokenEntry[];
}

/** v1.6 — collected outcome of a streaming /redact-pdf call. The
 *  consumer can also subscribe to per-page events as they arrive. */
export interface RedactPdfResponse {
  pdf_sha256: string;
  pages_count: number;
  pages: RedactPdfPage[];
  tokens_concatenated: EngineTokenEntry[];
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

  /**
   * Phase 17 — redact a single image. ``imageBytes`` is the raw PNG /
   * JPEG / WebP bytes; this method base64-encodes them for the
   * engine's JSON body. The engine returns the masked PNG as base64
   * plus per-region bbox metadata.
   */
  async redactImage(
    imageBytes: Buffer,
    correlationId?: string,
  ): Promise<RedactImageResponse> {
    return this.post<RedactImageResponse>(
      '/redact-image',
      { image_base64: imageBytes.toString('base64') },
      correlationId,
      // Image redaction is heavier than text (OCR + face detection +
      // barcode scan); give it a longer timeout than the default 30s.
      120_000,
    );
  }

  /**
   * v1.6 — streaming PDF redaction. The engine emits one NDJSON line
   * per page as it finishes, plus a final ``summary`` line. The
   * caller receives each page via ``onPage`` in real time; the
   * resolved value carries the aggregated result for persistence.
   *
   * ``onPage`` is best-effort: a throw is logged but doesn't abort
   * the stream. The pipeline uses it to emit SSE ``page_completed``
   * events to subscribers.
   *
   * Timeout still bounds the whole stream (~30 min for huge PDFs).
   */
  async redactPdf(
    pdfBytes: Buffer,
    opts: {
      dpi?: number;
      timeoutMs?: number;
      correlationId?: string;
      onPage?: (page: RedactPdfPage) => void;
    } = {},
  ): Promise<RedactPdfResponse> {
    const dpi = opts.dpi ?? 200;
    const ctl = new AbortController();
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (opts.correlationId !== undefined) {
        headers['x-correlation-id'] = opts.correlationId;
      }
      const res = await this.fetchImpl(`${this.baseUrl}/redact-pdf`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pdf_base64: pdfBytes.toString('base64'), dpi }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        throw new EngineFailureError(
          `engine /redact-pdf returned ${res.status.toString()}`,
          res.status,
        );
      }
      if (res.body === null) {
        throw new EngineUnreachableError('engine /redact-pdf returned no body');
      }
      const pages: RedactPdfPage[] = [];
      let summary: RedactPdfSummary | undefined;
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (line.length === 0) continue;
          let parsed: { type?: string; message?: string } & RedactPdfPage &
            RedactPdfSummary;
          try {
            parsed = JSON.parse(line) as typeof parsed;
          } catch {
            throw new EngineFailureError(
              `engine /redact-pdf emitted invalid JSON line`,
              500,
            );
          }
          if (parsed.type === 'page') {
            const page: RedactPdfPage = {
              page_number: parsed.page_number,
              masked_image_sha256: parsed.masked_image_sha256,
              masked_image_base64: parsed.masked_image_base64,
              redacted_text: parsed.redacted_text,
              tokens: parsed.tokens,
              masked_regions: parsed.masked_regions,
              ...(parsed.total_pages !== undefined
                ? { total_pages: parsed.total_pages }
                : {}),
            };
            pages.push(page);
            if (opts.onPage !== undefined) {
              try {
                opts.onPage(page);
              } catch {
                // best-effort; don't abort the stream
              }
            }
          } else if (parsed.type === 'summary') {
            summary = {
              pdf_sha256: parsed.pdf_sha256,
              pages_count: parsed.pages_count,
              tokens_concatenated: parsed.tokens_concatenated,
            };
          } else if (parsed.type === 'error') {
            throw new EngineFailureError(
              parsed.message ?? 'engine /redact-pdf failed mid-stream',
              500,
            );
          }
        }
      }
      if (summary === undefined) {
        throw new EngineFailureError(
          'engine /redact-pdf stream ended without summary',
          500,
        );
      }
      return {
        pdf_sha256: summary.pdf_sha256,
        pages_count: summary.pages_count,
        pages,
        tokens_concatenated: summary.tokens_concatenated,
      };
    } catch (err) {
      if (err instanceof EngineFailureError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EngineUnreachableError(
          `engine /redact-pdf timed out after ${timeoutMs.toString()}ms`,
        );
      }
      throw new EngineUnreachableError(
        err instanceof Error ? err.message : 'unknown',
      );
    } finally {
      clearTimeout(t);
    }
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
    timeoutMsOverride?: number,
  ): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(
      () => ctl.abort(),
      timeoutMsOverride ?? this.timeoutMs,
    );
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
        const ms = timeoutMsOverride ?? this.timeoutMs;
        throw new EngineUnreachableError(`engine ${path} timed out after ${ms.toString()}ms`);
      }
      throw new EngineUnreachableError(
        err instanceof Error ? err.message : 'unknown',
      );
    } finally {
      clearTimeout(t);
    }
  }
}
