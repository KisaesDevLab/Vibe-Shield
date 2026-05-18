import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type MeResponse,
  type RedactJobRow,
} from '../api.js';

interface Props {
  client: AdminClient;
  me: MeResponse;
}

const ACCEPT = '.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,image/*';
const ACCEPT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/tiff',
  'image/bmp',
]);

/**
 * User-facing Redact UI — Phase 17 v1.4.
 *
 * Drop an image, watch the gateway redact it (the pipeline is
 * synchronous in v1.4 so a single HTTP round-trip), then see the
 * tokens that were found + download the redacted PDF / extracted
 * markdown / extracted JSON. The history table below shows your
 * recent jobs.
 *
 * PDF support arrives in v1.5.
 */
export function RedactView({ client, me }: Props): JSX.Element {
  const [history, setHistory] = useState<RedactJobRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const canUpload =
    me.is_org_admin ||
    me.roles.redact === 'operator' ||
    me.roles.redact === 'admin';

  const refresh = async (): Promise<void> => {
    try {
      const rows = await client.listRedactJobs(50);
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
    if (!ACCEPT_MIMES.has(file.type)) {
      setUploadError(
        `Unsupported file type: ${file.type || 'unknown'}. v1.4 accepts PNG/JPEG/WebP/TIFF/BMP. PDF support arrives in v1.5.`,
      );
      return;
    }
    setUploading(true);
    try {
      const job = await client.uploadRedact(file);
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
    const f = e.target.files?.[0];
    if (f !== undefined) void handleFile(f);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f !== undefined) void handleFile(f);
  };

  const selected = history.find((j) => j.id === selectedId) ?? null;

  const deleteJob = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this job? The redacted output and source upload will be removed from the appliance.')) {
      return;
    }
    try {
      await client.deleteRedactJob(id);
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
      <h2>Redact a document</h2>
      <p className="muted">
        Drop an image; we'll run OCR + Presidio + face / signature /
        barcode detection and give you back the redacted PDF, an
        extracted-text Markdown file, and a JSON token map. Cleartext
        stays on this appliance — only opaque tokens are sent if you
        later ship the result to Anthropic.
      </p>

      {!canUpload && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            You have read-only access to the Redact module. Contact an
            org admin to upgrade your role to <code>operator</code> to
            upload documents.
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
            {uploading ? 'Redacting…' : 'Drop an image here'}
          </p>
          <p className="muted" style={{ margin: '0 0 16px 0', fontSize: 13 }}>
            PNG, JPEG, WebP, TIFF, BMP · up to 25 MB
          </p>
          <button
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? 'Working…' : 'Or choose a file'}
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

      {selected !== null && <JobDetail job={selected} client={client} />}

      <h3 style={{ marginTop: 32 }}>History</h3>
      {loadError !== null && <p className="error">{loadError}</p>}
      {history.length === 0 && !loadError && (
        <p className="muted">No jobs yet — drop a file above to get started.</p>
      )}
      {history.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Filename</th>
              <th>Status</th>
              <th>Size</th>
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
                <td>{j.filename}</td>
                <td>
                  <StatusPill status={j.status} />
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {formatBytes(j.source_size_bytes)}
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

function JobDetail({ job, client }: { job: RedactJobRow; client: AdminClient }): JSX.Element {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: '0 0 4px 0' }}>{job.filename}</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <code style={{ fontSize: 11 }}>{job.id}</code> · {job.mime} ·{' '}
            {formatBytes(job.source_size_bytes)}
          </p>
        </div>
        <StatusPill status={job.status} />
      </div>

      {job.status === 'failed' && job.error_message !== null && (
        <p className="error" style={{ marginTop: 16 }}>
          {job.error_message}
        </p>
      )}

      {job.status === 'completed' && (
        <div style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: '0 0 8px 0', fontSize: 13 }}>
            Downloads:
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a
              href={client.redactArtifactUrl(job.id, 'redacted')}
              download
            >
              <button>Redacted PDF</button>
            </a>
            <a href={client.redactArtifactUrl(job.id, 'extracted_md')} download>
              <button className="secondary">Extracted text (.md)</button>
            </a>
            <a
              href={client.redactArtifactUrl(job.id, 'extracted_json')}
              download
            >
              <button className="secondary">Token map (.json)</button>
            </a>
            <a href={client.redactArtifactUrl(job.id, 'source')} download>
              <button className="secondary">Original source</button>
            </a>
          </div>
          <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
            Auto-expires {new Date(job.expires_at).toLocaleDateString()}.
            Artifacts are stored encrypted-at-rest on the appliance volume.
          </p>
        </div>
      )}

      {job.status === 'running' && (
        <p className="muted" style={{ marginTop: 16 }}>
          Redacting… (this typically takes 5–15 seconds per image).
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RedactJobRow['status'] }): JSX.Element {
  const colors: Record<RedactJobRow['status'], { bg: string; fg: string }> = {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
