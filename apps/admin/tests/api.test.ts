/**
 * AdminClient unit tests. Verifies the auth header is sent on every
 * call and that responses are parsed correctly. We mock fetch so no
 * real network is touched.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AdminApiError, AdminClient } from '../src/api.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AdminClient', () => {
  it('sends X-Admin-Key on listApiKeys', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const c = new AdminClient('sk-vs-admin-test');
    await c.listApiKeys();
    expect(fetchMock).toHaveBeenCalledOnce();
    const args = fetchMock.mock.calls[0]!;
    expect(args[0]).toBe('/v1/admin/api-keys');
    const headers = (args[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Admin-Key']).toBe('sk-vs-admin-test');
  });

  it('serializes body for issueApiKey', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'abc', key: 'vs_live_xxx' }, 201));
    const c = new AdminClient('sk');
    const r = await c.issueApiKey({ tenantId: 't1', label: 'mybooks-prod' });
    expect(r.id).toBe('abc');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ tenantId: 't1', label: 'mybooks-prod' }));
  });

  it('throws AdminApiError on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const c = new AdminClient('sk');
    await expect(c.listApiKeys()).rejects.toBeInstanceOf(AdminApiError);
  });

  it('handles 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const c = new AdminClient('sk');
    await expect(c.revokeApiKey('id-1')).resolves.toBeUndefined();
  });
});
