import { useEffect, useState } from 'react';

import { AdminApiError, type AdminClient, type RecognizerMissRow } from '../api.js';

interface Props {
  client: AdminClient;
}

export function RecognizerMissesView({ client }: Props): JSX.Element {
  const [rows, setRows] = useState<RecognizerMissRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setRows(await client.listRecognizerMisses({ limit: 100 }));
    } catch (e) {
      setError(e instanceof AdminApiError ? `${e.status}` : 'load failed');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <h2>Recognizer Misses</h2>
      <p className="muted">
        Backstop catches that Presidio's NER missed. Sample hashes only; cleartext is never persisted.
      </p>

      <div className="card">
        {error !== null && <p className="error">{error}</p>}
        {rows !== null && rows.length === 0 && <p className="muted">No misses recorded.</p>}
        {rows !== null && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Pattern</th>
                <th>Sample hash</th>
                <th>Severity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.created_at}</td>
                  <td>{r.pattern}</td>
                  <td><span className="code">{r.sample_hash.slice(0, 16)}…</span></td>
                  <td>{r.severity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
