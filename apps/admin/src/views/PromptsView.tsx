import { useEffect, useState } from 'react';

import { AdminApiError, type AdminClient, type PromptRow } from '../api.js';

interface Props {
  client: AdminClient;
}

/**
 * Read-only listing of versioned prompt templates (Phase 25 G2.6).
 *
 * Operators can verify which prompts are loaded on the appliance and
 * what their SHA-256 fingerprints are. The SHA appears in the audit
 * row of every Claude call that uses a template, so this view is the
 * companion that lets a reviewer answer "which version of the bank-
 * statement prompt produced this extraction?" without git access to
 * the running container.
 *
 * Editing is out of scope: templates are immutable from the gateway's
 * perspective. Operators wanting a new version drop a new .md file
 * into the prompts directory and restart — the registry detects the
 * SHA change and surfaces the new id.
 */
export function PromptsView({ client }: Props): JSX.Element {
  const [rows, setRows] = useState<PromptRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        setRows(await client.listPrompts());
      } catch (e) {
        setError(
          e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'load failed',
        );
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [client]);

  return (
    <div>
      <h2>Prompt Templates</h2>
      <p className="muted">
        Versioned prompts the gateway exposes to the internal service
        API. Each template's SHA is recorded in the audit row of every
        Claude call that uses it, so a future reviewer can prove which
        prompt produced which extraction.
      </p>

      {loading && <p className="muted">…</p>}
      {error !== null && <p className="error">{error}</p>}
      {!loading && rows.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No templates loaded. Mount a directory of <code>*.md</code>{' '}
            files and set <code>PROMPTS_DIR</code> in the gateway env to
            surface them here. See{' '}
            <code>apps/gateway/src/prompts/README.md</code> for the file
            format.
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>SHA-256 (16 hex)</th>
              <th>Description</th>
              <th>Model hint</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.id}</code>
                </td>
                <td>
                  <code title={p.sha}>{p.sha.slice(0, 16)}…</code>
                </td>
                <td>{p.description ?? <span className="muted">—</span>}</td>
                <td>
                  {p.model_hint !== null ? (
                    <code>{p.model_hint}</code>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
