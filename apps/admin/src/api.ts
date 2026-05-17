/**
 * Admin API client. All calls require an X-Admin-Key header set via
 * the AdminKeyContext on first load. The key is held in memory only —
 * never localStorage / sessionStorage — so a refresh re-prompts.
 *
 * Hard rule: this client must NEVER log the key. Never console.log a
 * full Headers object. Errors expose status + endpoint, not the key.
 */

// Derived from Vite's BASE_URL so admin fetches respect the runtime
// mount point. In dev: BASE_URL='/' → BASE=''. In a production build
// (which Vite compiles BASE_URL into as a string literal): BASE_URL
// starts as the sentinel '/__VIBE_BASE_PATH__/' and gets sed-substituted
// to the real prefix by the nginx entrypoint (e.g. '/shield/'), so
// BASE ends up as '/shield' and fetches go to '/shield/v1/admin/...'.
// Trailing slash trimmed so concatenating with leading-slash paths
// doesn't double up.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export class AdminApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export class AdminClient {
  constructor(private readonly adminKey: string) {}

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: {
        'X-Admin-Key': this.adminKey,
        'Content-Type': 'application/json',
      },
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal !== undefined) {
      init.signal = opts.signal;
    }
    const res = await fetch(`${BASE}${path}`, init);
    if (!res.ok) {
      // Never include the body in the error message — could contain
      // hashes / IDs that leak in client logs. Status + endpoint only.
      throw new AdminApiError(
        `admin API ${path} returned ${res.status}`,
        res.status,
        path,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ----- API Keys -------------------------------------------------

  listApiKeys(): Promise<ApiKeyRow[]> {
    return this.request('/v1/admin/api-keys');
  }

  issueApiKey(input: { tenantId: string; label: string }): Promise<ApiKeyIssueResponse> {
    return this.request('/v1/admin/api-keys', { method: 'POST', body: input });
  }

  revokeApiKey(keyId: string): Promise<void> {
    return this.request(`/v1/admin/api-keys/${keyId}`, { method: 'DELETE' });
  }

  // ----- Audit ----------------------------------------------------

  listAuditEvents(params: { tenantId?: string; limit?: number } = {}): Promise<AuditRow[]> {
    const qs = new URLSearchParams();
    if (params.tenantId !== undefined) qs.set('tenant_id', params.tenantId);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const path = `/v1/admin/audit${qs.toString() ? `?${qs.toString()}` : ''}`;
    return this.request(path);
  }

  // ----- Recognizer misses ---------------------------------------

  listRecognizerMisses(params: { limit?: number } = {}): Promise<RecognizerMissRow[]> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const path = `/v1/admin/recognizer-misses${qs.toString() ? `?${qs.toString()}` : ''}`;
    return this.request(path);
  }

  // ----- Anthropic probe -----------------------------------------

  reprobeAnthropic(): Promise<AnthropicProbeResult> {
    return this.request('/v1/admin/anthropic/probe', { method: 'POST' });
  }

  // ----- Policies ------------------------------------------------

  listPolicies(): Promise<PolicySummary[]> {
    return this.request('/v1/admin/policies');
  }
}

// ----- API row types -----

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyIssueResponse {
  id: string;
  /** The cleartext key. Shown ONCE on issue. Never persisted. */
  key: string;
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  session_id: string | null;
  event_type: string;
  payload_hash: string; // hex
  created_at: string;
}

export interface RecognizerMissRow {
  id: string;
  pattern: string;
  sample_hash: string;
  severity: string;
  created_at: string;
}

export interface AnthropicProbeResult {
  ok: boolean;
  reason?: string;
  models_visible?: number;
}

export interface PolicySummary {
  id: string;
  name: string;
  version: number;
  zdr_required: boolean;
}
