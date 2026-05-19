import { useEffect, useState } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type MeResponse,
  type ScheduledScanInput,
  type ScheduledScanRow,
} from '../api.js';

interface Props {
  client: AdminClient;
  me: MeResponse;
}

/**
 * Scheduled scans — Phase 26 v1.9.
 *
 * One per row: name, source path under the scan root, a 5-field
 * cron expression in UTC, alert severity threshold, optional email
 * recipients, optional webhook URL + HMAC secret. Webhook secrets
 * are write-only — the API never returns them.
 */
export function ScheduledScansView({ client, me }: Props): JSX.Element {
  const [rows, setRows] = useState<ScheduledScanRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduledScanInput>(emptyDraft());

  const canEdit =
    me.is_org_admin ||
    me.roles.scan === 'operator' ||
    me.roles.scan === 'admin';

  const refresh = async (): Promise<void> => {
    try {
      const list = await client.listScheduledScans();
      setRows(list);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'failed to load',
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, [client]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    setSaveErr(null);
    try {
      await client.createScheduledScan({
        ...draft,
        source_kind: 'filesystem',
      });
      setDraft(emptyDraft());
      await refresh();
    } catch (e) {
      setSaveErr(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'save failed',
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: ScheduledScanRow): Promise<void> => {
    try {
      await client.updateScheduledScan(row.id, { enabled: !row.enabled });
      await refresh();
    } catch (e) {
      setSaveErr(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'toggle failed',
      );
    }
  };

  const remove = async (row: ScheduledScanRow): Promise<void> => {
    if (
      !window.confirm(
        `Delete scheduled scan "${row.name}"? Past runs and their findings stay.`,
      )
    ) {
      return;
    }
    try {
      await client.deleteScheduledScan(row.id);
      await refresh();
    } catch (e) {
      setSaveErr(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'delete failed',
      );
    }
  };

  return (
    <div>
      <h2>Scheduled scans</h2>
      <p className="muted">
        Re-run a scan against an appliance-local path on a UTC cron
        cadence. The scheduler walks every supported file under the
        path (recursively, up to 5 levels deep) and dispatches each
        through the scanner registry. New high-severity findings can
        trigger SMTP and/or webhook alerts.
      </p>

      {!canEdit && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            You have read-only access. Contact an org admin to upgrade
            to the <code>scan</code> operator role.
          </p>
        </div>
      )}

      {canEdit && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 8px 0' }}>New scheduled scan</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
              Name
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Nightly client folder scan"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
              Source path
              <input
                type="text"
                value={draft.source_ref}
                onChange={(e) =>
                  setDraft({ ...draft, source_ref: e.target.value })
                }
                placeholder="clients/2026/q1"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
              Cron (UTC, 5 fields)
              <input
                type="text"
                value={draft.cron_expression}
                onChange={(e) =>
                  setDraft({ ...draft, cron_expression: e.target.value })
                }
                placeholder="0 6 * * *"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
              Alert min severity
              <select
                value={draft.alert_min_severity ?? 'high'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    alert_min_severity: e.target.value as 'low' | 'medium' | 'high',
                  })
                }
              >
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
              Notify emails (comma-separated)
              <input
                type="text"
                value={draft.notify_emails ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, notify_emails: e.target.value })
                }
                placeholder="alerts@firm.example"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
              Webhook URL
              <input
                type="url"
                value={draft.webhook_url ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, webhook_url: e.target.value })
                }
                placeholder="https://soc.firm.example/vibe-shield"
              />
            </label>
            <label
              style={{
                gridColumn: '1 / span 2',
                display: 'flex',
                flexDirection: 'column',
                fontSize: 12,
              }}
            >
              Webhook secret (HMAC-SHA256; write-only)
              <input
                type="password"
                value={draft.webhook_secret ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, webhook_secret: e.target.value })
                }
              />
            </label>
          </div>
          {saveErr !== null && (
            <p className="error" style={{ marginTop: 8 }}>
              {saveErr}
            </p>
          )}
          <div style={{ marginTop: 12 }}>
            <button onClick={() => void submit()} disabled={saving}>
              {saving ? 'Saving…' : 'Create scheduled scan'}
            </button>
          </div>
        </div>
      )}

      <h3>Existing</h3>
      {loadErr !== null && <p className="error">{loadErr}</p>}
      {rows.length === 0 && loadErr === null && (
        <p className="muted">No scheduled scans yet.</p>
      )}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Cron (UTC)</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Alert</th>
              <th>Enabled</th>
              {canEdit && <th></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.source_kind}:{r.source_ref}
                </td>
                <td className="muted" style={{ fontSize: 12, fontFamily: 'monospace' }}>
                  {r.cron_expression}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.next_run_at !== null
                    ? new Date(r.next_run_at).toLocaleString()
                    : '—'}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.last_run_at !== null
                    ? new Date(r.last_run_at).toLocaleString()
                    : '—'}
                </td>
                <td>{r.alert_min_severity}</td>
                <td>{r.enabled ? 'yes' : 'no'}</td>
                {canEdit && (
                  <td>
                    <button
                      className="secondary"
                      style={{ fontSize: 11 }}
                      onClick={() => void toggleEnabled(r)}
                    >
                      {r.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="danger"
                      style={{ fontSize: 11, marginLeft: 6 }}
                      onClick={() => void remove(r)}
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function emptyDraft(): ScheduledScanInput {
  return {
    name: '',
    source_ref: '',
    cron_expression: '0 6 * * *',
    enabled: true,
    alert_min_severity: 'high',
  };
}
