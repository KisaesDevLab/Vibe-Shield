import { useEffect, useState } from 'react';

import { AdminApiError, type AdminClient, type PolicySummary } from '../api.js';

interface Props {
  client: AdminClient;
}

export function PoliciesView({ client }: Props): JSX.Element {
  const [rows, setRows] = useState<PolicySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setRows(await client.listPolicies());
    } catch (e) {
      setError(e instanceof AdminApiError ? `${e.status}` : 'load failed');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <h2>Policies</h2>
      <p className="muted">
        Read-only list of redaction / re-id policies. JSON editor view is deferred to v1.2.
      </p>

      <div className="card">
        {error !== null && <p className="error">{error}</p>}
        {rows !== null && rows.length === 0 && <p className="muted">No custom policies; built-ins applied.</p>}
        {rows !== null && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Version</th>
                <th>ZDR required</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className="code">{r.name}</span></td>
                  <td>{r.version}</td>
                  <td>{r.zdr_required ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
