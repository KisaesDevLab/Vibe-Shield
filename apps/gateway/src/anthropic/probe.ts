/**
 * Commercial-key probe.
 *
 * BUILD_PLAN §8 hard rule: "verify with a probe request on startup".
 * We hit Anthropic's GET /v1/models and require a 200. 401 / 403 means
 * the key is invalid or insufficiently privileged (e.g. a consumer-grade
 * key from claude.ai that isn't an actual API key). Any other status
 * fails closed — the gateway refuses to serve until corrected.
 *
 * The probe uses a direct ``fetch`` rather than the SDK so it isn't
 * coupled to a specific @anthropic-ai/sdk version's surface. The probe
 * runs synchronously at startup; there is no retry loop — if Anthropic
 * is having an outage on boot we'd rather refuse to start than serve a
 * degraded redaction path.
 */

export class ConsumerKeyError extends Error {
  override readonly name = 'ConsumerKeyError';
}

export class AnthropicUnreachableError extends Error {
  override readonly name = 'AnthropicUnreachableError';
}

export interface ProbeResult {
  /** Model IDs visible to the configured key. */
  models: string[];
}

export interface ProbeOptions {
  apiKey: string;
  baseURL?: string;
  /** Per-call timeout in ms; default 10s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Anthropic-Version header value; default ``2023-06-01``. */
  apiVersion?: string;
}

interface ModelsListResponse {
  data: { id: string }[];
}

/**
 * Probe Anthropic with the configured API key. Throws
 * ``ConsumerKeyError`` if the key is rejected; ``AnthropicUnreachableError``
 * for transport failures. On success, returns the visible model list.
 */
export async function probeAnthropicKey(options: ProbeOptions): Promise<ProbeResult> {
  const baseURL = (options.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(`${baseURL}/v1/models?limit=50`, {
      headers: {
        'x-api-key': options.apiKey,
        'anthropic-version': options.apiVersion ?? '2023-06-01',
      },
      signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConsumerKeyError(
        `Anthropic rejected the key (status ${res.status.toString()}). ` +
          'Only commercial API keys are accepted.',
      );
    }
    if (!res.ok) {
      throw new AnthropicUnreachableError(
        `Anthropic probe returned ${res.status.toString()}`,
      );
    }
    const body = (await res.json()) as ModelsListResponse;
    return { models: body.data.map((m) => m.id) };
  } catch (err) {
    if (err instanceof ConsumerKeyError || err instanceof AnthropicUnreachableError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AnthropicUnreachableError('Anthropic probe timed out');
    }
    throw new AnthropicUnreachableError(
      err instanceof Error ? err.message : 'Anthropic unreachable',
    );
  } finally {
    clearTimeout(t);
  }
}
