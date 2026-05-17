/**
 * api.ts derives its request prefix from `import.meta.env.BASE_URL`,
 * which Vite compiles in at build time. In production builds the value
 * starts as the sentinel `/__VIBE_BASE_PATH__/` and the nginx
 * entrypoint shim (docker-entrypoint.d/40-base-path.sh) sed-substitutes
 * it with the runtime $VITE_BASE_PATH (e.g. `/shield/` when mounted
 * behind Caddy at `/shield/*`).
 *
 * These tests pin the BASE → fetch-URL contract for the two
 * deployment shapes Caddy serves: (a) appliance path-mount under
 * `/shield/`, (b) standalone/subdomain root. Without coverage here,
 * a future tweak to api.ts's BASE derivation could silently 404 every
 * admin call in path-mount deployments.
 *
 * Mechanism: vi.stubEnv before dynamic-import of api.ts so the module's
 * top-level BASE constant captures the stubbed value. vi.resetModules
 * ensures each test gets a fresh evaluation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AdminClient — BASE_URL prefix wiring', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('appliance path-mount: BASE_URL=/shield/ → fetches /shield/v1/admin/*', async () => {
    vi.stubEnv('BASE_URL', '/shield/');
    fetchMock.mockResolvedValueOnce(ok([]));
    const { AdminClient } = await import('../src/api.js');
    await new AdminClient('sk').listApiKeys();
    expect(fetchMock.mock.calls[0]![0]).toBe('/shield/v1/admin/api-keys');
  });

  it('subdomain / root mount: BASE_URL=/ → fetches /v1/admin/*', async () => {
    vi.stubEnv('BASE_URL', '/');
    fetchMock.mockResolvedValueOnce(ok([]));
    const { AdminClient } = await import('../src/api.js');
    await new AdminClient('sk').listApiKeys();
    expect(fetchMock.mock.calls[0]![0]).toBe('/v1/admin/api-keys');
  });

  it('custom operator prefix: BASE_URL=/internal/shield/ → fetches /internal/shield/v1/admin/*', async () => {
    vi.stubEnv('BASE_URL', '/internal/shield/');
    fetchMock.mockResolvedValueOnce(ok([]));
    const { AdminClient } = await import('../src/api.js');
    await new AdminClient('sk').listApiKeys();
    expect(fetchMock.mock.calls[0]![0]).toBe('/internal/shield/v1/admin/api-keys');
  });

  it('trailing slash is normalized so paths do not double up', async () => {
    // BASE_URL always carries a trailing slash from Vite. The BASE
    // derivation in api.ts strips it so request paths (which start
    // with /) don't produce //v1/admin/... double-slashes.
    vi.stubEnv('BASE_URL', '/shield/');
    fetchMock.mockResolvedValueOnce(ok({}));
    const { AdminClient } = await import('../src/api.js');
    await new AdminClient('sk').reprobeAnthropic();
    expect(fetchMock.mock.calls[0]![0]).toBe('/shield/v1/admin/anthropic/probe');
    expect(fetchMock.mock.calls[0]![0]).not.toContain('//');
  });
});
