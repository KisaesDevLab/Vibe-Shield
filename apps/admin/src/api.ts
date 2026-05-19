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
  /**
   * @param adminKey  Legacy ``X-Admin-Key`` (Phase 13). When undefined,
   *                  the client relies on the ``vs_session`` cookie set
   *                  by Phase 24 magic-link sign-in. Both paths work
   *                  for /v1/admin/* routes.
   */
  constructor(private readonly adminKey: string | undefined = undefined) {}

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.adminKey !== undefined) {
      headers['X-Admin-Key'] = this.adminKey;
    }
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
      // Send vs_session cookie with same-origin requests so the
      // session-auth middleware can resolve req.user.
      credentials: 'same-origin',
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

  // ----- Auth (Phase 24) ------------------------------------------

  /** Hydrate the signed-in user. 401 if no session + no admin key. */
  me(): Promise<MeResponse> {
    return this.request('/api/auth/me');
  }

  /** Request a magic-link email. Always returns 204; never leaks
   *  whether the email exists. */
  requestMagicLink(email: string): Promise<void> {
    return this.request('/api/auth/request-link', {
      method: 'POST',
      body: { email },
    });
  }

  /** Clear the session cookie + revoke server-side. */
  logout(): Promise<void> {
    return this.request('/api/auth/logout', { method: 'POST' });
  }

  // ----- Users (Phase 24) -----------------------------------------

  listUsers(): Promise<UserRow[]> {
    return this.request('/v1/admin/users');
  }

  inviteUser(input: {
    email: string;
    isOrgAdmin?: boolean;
    roles?: Partial<Record<'redact' | 'scan' | 'compliance', 'viewer' | 'operator' | 'admin'>>;
  }): Promise<UserInviteResponse> {
    return this.request('/v1/admin/users', { method: 'POST', body: input });
  }

  setUserRole(
    userId: string,
    module: 'redact' | 'scan' | 'compliance',
    role: 'viewer' | 'operator' | 'admin',
  ): Promise<void> {
    return this.request(`/v1/admin/users/${userId}/roles`, {
      method: 'PUT',
      body: { module, role },
    });
  }

  revokeUserRole(
    userId: string,
    module: 'redact' | 'scan' | 'compliance',
  ): Promise<void> {
    return this.request(`/v1/admin/users/${userId}/roles/${module}`, {
      method: 'DELETE',
    });
  }

  setUserOrgAdmin(userId: string, isOrgAdmin: boolean): Promise<void> {
    return this.request(`/v1/admin/users/${userId}/org-admin`, {
      method: 'PUT',
      body: { isOrgAdmin },
    });
  }

  disableUser(userId: string): Promise<void> {
    return this.request(`/v1/admin/users/${userId}`, { method: 'DELETE' });
  }

  // ----- Prompts (Phase 25 G2.6) ---------------------------------

  listPrompts(): Promise<PromptRow[]> {
    return this.request('/v1/admin/prompts');
  }

  // ----- Redact module (Phase 17 v1.4) ---------------------------

  /** v1.6 — bulk upload. Returns the batch + array of jobs. */
  async uploadRedactBatch(
    files: File[],
    name?: string,
  ): Promise<{ batch: RedactBatchRow; jobs: RedactJobRow[] }> {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (name !== undefined) fd.append('name', name);
    const headers: Record<string, string> = {};
    if (this.adminKey !== undefined) {
      headers['X-Admin-Key'] = this.adminKey;
    }
    const res = await fetch(`${BASE}/v1/redact/batches`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: fd,
    });
    if (!res.ok) {
      let message = `batch upload returned ${String(res.status)}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message !== undefined) message = body.error.message;
      } catch {
        // ignore
      }
      throw new AdminApiError(message, res.status, '/v1/redact/batches');
    }
    return (await res.json()) as { batch: RedactBatchRow; jobs: RedactJobRow[] };
  }

  async uploadRedact(file: File): Promise<RedactJobRow> {
    const fd = new FormData();
    fd.append('file', file);
    const headers: Record<string, string> = {};
    if (this.adminKey !== undefined) {
      headers['X-Admin-Key'] = this.adminKey;
    }
    const res = await fetch(`${BASE}/v1/redact/jobs`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: fd,
    });
    if (!res.ok) {
      let message = `upload returned ${String(res.status)}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message !== undefined) message = body.error.message;
      } catch {
        // ignore body parse failures
      }
      throw new AdminApiError(message, res.status, '/v1/redact/jobs');
    }
    return (await res.json()) as RedactJobRow;
  }

  listRedactJobs(limit = 50): Promise<RedactJobRow[]> {
    return this.request(`/v1/redact/jobs?limit=${String(limit)}`);
  }

  getRedactJob(id: string): Promise<RedactJobRow> {
    return this.request(`/v1/redact/jobs/${id}`);
  }

  redactArtifactUrl(
    jobId: string,
    kind: 'source' | 'redacted' | 'extracted_md' | 'extracted_json',
  ): string {
    return `${BASE}/v1/redact/jobs/${jobId}/artifacts/${kind}`;
  }

  deleteRedactJob(id: string): Promise<void> {
    return this.request(`/v1/redact/jobs/${id}`, { method: 'DELETE' });
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

  // ----- Anthropic key (Phase 23.5) -------------------------------

  getAnthropicKeyStatus(): Promise<AnthropicKeyStatus> {
    return this.request('/v1/admin/anthropic/key');
  }

  /**
   * Set or rotate the Anthropic key. The plaintext is sent once over
   * the admin TLS channel; the gateway probes it, persists it
   * encrypted under the appliance KEK on success, and atomically
   * reloads the in-memory client. The plaintext is never returned in
   * any subsequent call.
   */
  setAnthropicKey(key: string): Promise<AnthropicKeyStatus> {
    return this.request('/v1/admin/anthropic/key', {
      method: 'PUT',
      body: { key },
    });
  }

  /** Revert to the env-backed bootstrap key. */
  clearAnthropicKey(): Promise<void> {
    return this.request('/v1/admin/anthropic/key', { method: 'DELETE' });
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

/** Phase 23.5 status payload from GET /v1/admin/anthropic/key. */
export interface AnthropicKeyStatus {
  /** ``'env'`` = boot ANTHROPIC_API_KEY; ``'db'`` = operator set in admin UI. */
  source: 'env' | 'db';
  /** SHA-256(plaintext) prefix (16 hex chars). null when no key is set anywhere. */
  fingerprint: string | null;
  /** ISO timestamp; null when source==='env'. */
  set_at: string | null;
  /** Whether ANTHROPIC_API_KEY is set in env. Determines whether
   *  ``Revert to env-backed key`` is available. */
  bootstrap_present?: boolean;
}

export interface PolicySummary {
  id: string;
  name: string;
  version: number;
  zdr_required: boolean;
}

/** Phase 24 — Users + RBAC. */
export type ModuleName = 'redact' | 'scan' | 'compliance';
export type RoleName = 'viewer' | 'operator' | 'admin';

export interface UserRow {
  id: string;
  email: string;
  is_org_admin: boolean;
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
  roles: Partial<Record<ModuleName, RoleName>>;
}

export interface UserInviteResponse {
  id: string;
  email: string;
  is_org_admin: boolean;
  /** True iff SMTP was configured and the magic-link email was sent. */
  invited: boolean;
}

export interface MeResponse {
  id: string;
  email: string;
  is_org_admin: boolean;
  roles: Partial<Record<ModuleName, RoleName>>;
  mailer_configured: boolean;
}

/** Phase 25 G2.6 — prompt template summary surfaced in the admin SPA. */
export interface PromptRow {
  id: string;
  /** SHA-256 of the raw template file (64 hex chars). Recorded in
   *  the audit row of every call that uses this template. */
  sha: string;
  description: string | null;
  model_hint: string | null;
}

/** Phase 17 v1.4 — user-initiated document redaction job. */
export interface RedactJobRow {
  id: string;
  user_id: string;
  filename: string;
  mime: string;
  source_size_bytes: number;
  pages_count: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string;
  /** v1.6 — batch this job belongs to (null for single-file uploads). */
  batch_id: string | null;
}

/** v1.6 — bulk-redact batch. */
export interface RedactBatchRow {
  id: string;
  user_id: string;
  name: string | null;
  total_jobs: number;
  created_at: string;
}
