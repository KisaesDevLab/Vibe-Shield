import { useEffect, useState } from 'react';

import { AdminApiError, type AdminClient, type AuditRow } from '../api.js';

interface Props {
  client: AdminClient;
}

export function AuditView({ client }: Props): JSX.Element {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [tenant, setTenant] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params: { tenantId?: string; limit?: number } = { limit: 100 };
      if (tenant.trim() !== '') params.tenantId = tenant.trim();
      setRows(await client.listAuditEvents(params));
    } catch (e) {
      setError(e instanceof AdminApiError ? `${e.status}` : 'load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <h2>Audit Log</h2>
      <p className="muted">
        Append-only audit trail. Payload bodies are SHA-256-hashed at write time;
        cleartext is never persisted or returned by the API.
      </p>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input
            type="text"
            placeholder="filter by tenant ID (optional)"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
          />
          <button onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Search'}
          </button>
        </div>
        {error !== null && <p className="error">{error}</p>}
        {rows !== null && rows.length === 0 && <p className="muted">No matching events.</p>}
        {rows !== null && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Tenant</th>
                <th>Session</th>
                <th>Event</th>
                <th>Payload hash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.created_at}</td>
                  <td>{r.tenant_id}</td>
                  <td className="muted">{r.session_id ?? '—'}</td>
                  <td>{r.event_type}</td>
                  <td><span className="code">{r.payload_hash.slice(0, 16)}…</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
