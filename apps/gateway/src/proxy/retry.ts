/**
 * Retry with exponential backoff + full jitter.
 *
 * Only retries Anthropic 5xx and 429s; never retries 4xx (the request
 * itself is wrong) or our own redaction/vault errors (those are our
 * bug, not a transient).
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface AnthropicLikeError {
  status?: number;
  message?: string;
}

export async function withRetry<T>(
  op: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const max = options.maxAttempts ?? 3;
  const base = options.baseDelayMs ?? 250;
  const ceiling = options.maxDelayMs ?? 8_000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await op();
    } catch (err) {
      const e = err as AnthropicLikeError;
      const retryable =
        typeof e.status === 'number' && (e.status === 429 || e.status >= 500);
      if (!retryable || attempt >= max) {
        throw err;
      }
      const expBackoff = Math.min(ceiling, base * 2 ** (attempt - 1));
      // Full jitter: random delay in [0, expBackoff].
      const delay = Math.floor(Math.random() * expBackoff);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
