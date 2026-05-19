import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type MeResponse,
  type ScanFindingRow,
  type ScanJobRow,
} from '../api.js';

interface Props {
  client: AdminClient;
  me: MeResponse;
}

const ACCEPT =
  '.txt,.md,.log,.json,.csv,.pdf,.xlsx,.zip,text/*,application/pdf,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Scan view — Phase 26 (v1.8 foundation).
 *
 * Upload a file (or zip archive) → engine streams findings →
 * gateway persists → SPA polls the job + findings table.
 *
 * Live progress: subscribes to /v1/scan/jobs/:id/stream for SSE
 * events; falls back to polling /v1/scan/jobs/:id every 2s for the
 * status pill + counter row.
 */
export function ScanView({ client, me }: Props): JSX.Element {
  const [history, setHistory] = useState<ScanJobRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const canUpload =
    me.is_org_admin ||
    me.roles.scan === 'operator' ||
    me.roles.scan === 'admin';

  const refresh = async (): Promise<void> => {
    try {
      const rows = await client.listScanJobs(50);
      setHistory(rows);
      if (selectedId === null && rows.length > 0) {
        setSelectedId(rows[0]!.id);
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'failed to load history',
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, [client]);

  const handleFile = async (file: File): Promise<void> => {
    setUploadError(null);
    setUploading(true);
    try {
      const job = await client.uploadScan(file);
      setSelectedId(job.id);
      await refresh();
    } catch (e) {
      setUploadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'upload failed',
      );
    } finally {
      setUploading(false);
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const list = e.target.files;
    if (list !== null && list.length > 0) {
      void handleFile(list[0]!);
    }
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void handleFile(files[0]!);
  };

  const selected = history.find((j) => j.id === selectedId) ?? null;

  const deleteJob = async (id: string): Promise<void> => {
    if (
      !window.confirm(
        'Delete this scan? The job, files, and findings will be removed from the appliance.',
      )
    ) {
      return;
    }
    try {
      await client.deleteScanJob(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
    } catch (e) {
      setLoadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'delete failed',
      );
    }
  };

  return (
    <div>
      <h2>Scan for unredacted PII</h2>
      <p className="muted">
        Drop a file or a zip archive; we'll walk every inner document
        and report SSNs, EINs, bank accounts, names, addresses, and
        more — with line / cell / page locations. Cleartext stays on
        this appliance; the report carries hashes + tiny redacted
        snippets, never the matched PII itself.
      </p>

      {!canUpload && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            You have read-only access to the Scan module. Contact an
            org admin to upgrade your role to <code>operator</code> to
            run scans.
          </p>
        </div>
      )}

      {canUpload && (
        <div
          className="card"
          style={{
            border: dragOver ? '2px dashed #4f46e5' : '2px dashed #d1d5db',
            background: dragOver ? '#eef2ff' : '#fff',
            textAlign: 'center',
            padding: 32,
            transition: 'all 120ms',
            opacity: uploading ? 0.7 : 1,
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <p style={{ margin: '0 0 8px 0', fontSize: 16, fontWeight: 500 }}>
            {uploading ? 'Scanning…' : 'Drop a file or zip archive here'}
          </p>
          <p className="muted" style={{ margin: '0 0 16px 0', fontSize: 13 }}>
            TXT, MD, LOG, JSON, CSV, PDF (text layer), XLSX, or ZIP · up to 100 MB
          </p>
          <button disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? 'Working…' : 'Or choose file'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={onPick}
          />
          {uploadError !== null && (
            <p className="error" style={{ marginTop: 16 }}>
              {uploadError}
            </p>
          )}
        </div>
      )}

      {selected !== null && (
        <ScanDetail
          job={selected}
          client={client}
          canUpload={canUpload}
          onUpdated={() => void refresh()}
        />
      )}

      <h3 style={{ marginTop: 32 }}>History</h3>
      {loadError !== null && <p className="error">{loadError}</p>}
      {history.length === 0 && !loadError && (
        <p className="muted">No scans yet — drop a file above to get started.</p>
      )}
      {history.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Status</th>
              <th>Findings</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.map((j) => (
              <tr
                key={j.id}
                onClick={() => setSelectedId(j.id)}
                style={{
                  cursor: 'pointer',
                  background: j.id === selectedId ? '#eef2ff' : undefined,
                }}
              >
                <td>{j.source_name}</td>
                <td>
                  <StatusPill status={j.status} />
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  <SeverityCounters job={j} />
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {new Date(j.created_at).toLocaleString()}
                </td>
                <td>
                  {canUpload && (
                    <button
                      className="danger"
                      style={{ fontSize: 11 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteJob(j.id);
                      }}
                    >
                      Delete
                    </button>
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

function ScanDetail({
  job,
  client,
  canUpload: _canUpload,
  onUpdated,
}: {
  job: ScanJobRow;
  client: AdminClient;
  canUpload: boolean;
  onUpdated?: () => void;
}): JSX.Element {
  const [findings, setFindings] = useState<ScanFindingRow[]>([]);
  const [severityFilter, setSeverityFilter] = useState<
    'all' | 'low' | 'medium' | 'high'
  >('all');
  const [entityFilter, setEntityFilter] = useState<string>('');
  const [findingsErr, setFindingsErr] = useState<string | null>(null);

  // Poll the job + findings every 2s while running; stop on terminal.
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const list = await client.listScanFindings(job.id, {
          ...(severityFilter !== 'all' ? { severity: severityFilter } : {}),
          ...(entityFilter !== '' ? { entity_type: entityFilter } : {}),
          limit: 500,
        });
        if (stopped) return;
        setFindings(list);
        setFindingsErr(null);
      } catch (e) {
        if (stopped) return;
        setFindingsErr(
          e instanceof AdminApiError
            ? `${e.status}: ${e.message}`
            : 'failed to load findings',
        );
      }
    };
    void tick();
    if (job.status === 'pending' || job.status === 'running') {
      const i = setInterval(() => {
        void tick();
        onUpdated?.();
      }, 2000);
      return () => {
        stopped = true;
        clearInterval(i);
      };
    }
    return () => {
      stopped = true;
    };
  }, [job.id, job.status, severityFilter, entityFilter]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: '0 0 4px 0' }}>{job.source_name}</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <code style={{ fontSize: 11 }}>{job.id}</code> · {job.source_kind} ·{' '}
            {formatBytes(job.source_size_bytes)} · {job.files_count.toString()} file
            {job.files_count === 1 ? '' : 's'} scanned
          </p>
        </div>
        <StatusPill status={job.status} />
      </div>

      {job.status === 'failed' && job.error_message !== null && (
        <p className="error" style={{ marginTop: 16 }}>
          {job.error_message}
        </p>
      )}

      {(job.status === 'running' || job.status === 'pending') && (
        <p className="muted" style={{ marginTop: 16 }}>
          Scanning…
        </p>
      )}

      {job.status === 'completed' && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
            <strong>{job.findings_count.toString()}</strong>
            <span className="muted">
              finding{job.findings_count === 1 ? '' : 's'} across {job.files_count.toString()}{' '}
              file{job.files_count === 1 ? '' : 's'}
            </span>
            <a href={client.scanFindingsCsvUrl(job.id)} download>
              <button className="secondary" style={{ fontSize: 12 }}>
                Export CSV
              </button>
            </a>
          </div>
          <div style={{ marginTop: 12 }}>
            <SeverityCounters job={job} verbose />
          </div>
        </div>
      )}

      {(job.status === 'completed' ||
        job.status === 'running' ||
        job.findings_count > 0) && (
        <>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <select
              value={severityFilter}
              onChange={(e) =>
                setSeverityFilter(e.target.value as typeof severityFilter)
              }
            >
              <option value="all">All severities</option>
              <option value="high">High only</option>
              <option value="medium">Medium only</option>
              <option value="low">Low only</option>
            </select>
            <input
              type="text"
              placeholder="Entity type filter (e.g. US_SSN)"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>

          {findingsErr !== null && (
            <p className="error" style={{ marginTop: 12 }}>
              {findingsErr}
            </p>
          )}
          {findings.length === 0 ? (
            <p className="muted" style={{ marginTop: 12 }}>
              No findings match the current filter.
            </p>
          ) : (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Severity</th>
                  <th>Location</th>
                  <th>Context (redacted)</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <code style={{ fontSize: 12 }}>{f.entity_type}</code>
                    </td>
                    <td>
                      <SeverityPill severity={f.severity} />
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {f.location}
                    </td>
                    <td style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {f.snippet_redacted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ScanJobRow['status'] }): JSX.Element {
  const colors: Record<ScanJobRow['status'], { bg: string; fg: string }> = {
    pending: { bg: '#fef3c7', fg: '#92400e' },
    running: { bg: '#dbeafe', fg: '#1e40af' },
    completed: { bg: '#d1fae5', fg: '#065f46' },
    failed: { bg: '#fee2e2', fg: '#991b1b' },
  };
  const c = colors[status];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {status}
    </span>
  );
}

function SeverityPill({ severity }: { severity: 'low' | 'medium' | 'high' }): JSX.Element {
  const colors = {
    high: { bg: '#fee2e2', fg: '#991b1b' },
    medium: { bg: '#fef3c7', fg: '#92400e' },
    low: { bg: '#e0e7ff', fg: '#3730a3' },
  };
  const c = colors[severity];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      {severity}
    </span>
  );
}

function SeverityCounters({
  job,
  verbose = false,
}: {
  job: ScanJobRow;
  verbose?: boolean;
}): JSX.Element {
  const items: { label: string; n: number; sev: 'low' | 'medium' | 'high' }[] = [
    { label: 'high', n: job.findings_high, sev: 'high' },
    { label: 'medium', n: job.findings_medium, sev: 'medium' },
    { label: 'low', n: job.findings_low, sev: 'low' },
  ];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <SeverityPill severity={it.sev} />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{it.n.toString()}</span>
          {verbose && <span className="muted">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
