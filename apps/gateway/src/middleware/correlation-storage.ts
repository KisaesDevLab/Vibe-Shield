import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request AsyncLocalStorage. Lives in its own module so middleware
 * and the logger can both reference it without circular imports.
 */
export const correlationStorage = new AsyncLocalStorage<string>();

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}
