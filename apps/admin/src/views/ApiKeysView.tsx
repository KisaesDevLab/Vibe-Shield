import { useEffect, useState } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type ApiKeyIssueResponse,
  type ApiKeyRow,
} from '../api.js';

interface Props {
  client: AdminClient;
}

export function ApiKeysView({ client }: Props): JSX.Element {
  const [rows, setRows] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<ApiKeyIssueResponse | null>(null);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setRows(await client.listApiKeys());
    } catch (e) {
      setError(e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const issue = async (): Promise<void> => {
    if (tenantId.trim() === '' || label.trim() === '') return;
    setIssuing(true);
    setError(null);
    try {
      const r = await client.issueApiKey({ tenantId: tenantId.trim(), label: label.trim() });
      setIssued(r);
      setTenantId('');
      setLabel('');
      await refresh();
    } catch (e) {
      setError(e instanceof AdminApiError ? `issue failed: ${e.status}` : 'issue failed');
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    if (!confirm(`Revoke key ${id}? This cannot be undone.`)) return;
    try {
      await client.revokeApiKey(id);
      await refresh();
    } catch (e) {
      setError(e instanceof AdminApiError ? `revoke failed: ${e.status}` : 'revoke failed');
    }
  };

  return (
    <div>
      <h2>API Keys</h2>
      <p className="muted">Issued tenant API keys for the gateway. Cleartext key is shown once on issue and never persisted.</p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Issue a new key</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="tenant ID (e.g. acme-cpa)"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
          />
          <input
            type="text"
            placeholder="label (e.g. mybooks-prod)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button onClick={() => void issue()} disabled={issuing}>
            {issuing ? 'Issuing…' : 'Issue key'}
          </button>
        </div>
        {issued !== null && (
          <div style={{ marginTop: 16 }}>
            <p className="success">Key issued. Copy now — it won't be shown again.</p>
            <p>
              <span className="code">{issued.key}</span>
            </p>
            <button className="secondary" onClick={() => setIssued(null)}>
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Existing keys</h3>
          <button className="secondary" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {error !== null && <p className="error">{error}</p>}
        {rows !== null && rows.length === 0 && <p className="muted">No keys issued yet.</p>}
        {rows !== null && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Tenant</th>
                <th>Label</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className="code">{r.id.slice(0, 8)}…</span></td>
                  <td>{r.tenant_id}</td>
                  <td>{r.label}</td>
                  <td className="muted">{r.created_at}</td>
                  <td className="muted">{r.last_used_at ?? '—'}</td>
                  <td>
                    {r.revoked_at !== null ? (
                      <span className="muted">revoked</span>
                    ) : (
                      <span className="success">active</span>
                    )}
                  </td>
                  <td>
                    {r.revoked_at === null && (
                      <button className="danger" onClick={() => void revoke(r.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
