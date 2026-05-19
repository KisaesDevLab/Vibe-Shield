import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type MeResponse,
  type RedactBatchRow,
  type RedactJobRow,
} from '../api.js';

interface Props {
  client: AdminClient;
  me: MeResponse;
}

const ACCEPT = '.png,.jpg,.jpeg,.webp,.tif,.tiff,.bmp,.pdf,image/*,application/pdf';
const ACCEPT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'application/pdf',
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
  const [batches, setBatches] = useState<RedactBatchRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
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
      const [rows, batchRows] = await Promise.all([
        client.listRedactJobs(50),
        client.listRedactBatches(50).catch(() => [] as RedactBatchRow[]),
      ]);
      setHistory(rows);
      setBatches(batchRows);
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

  const handleFiles = async (files: File[]): Promise<void> => {
    setUploadError(null);
    for (const f of files) {
      if (!ACCEPT_MIMES.has(f.type)) {
        setUploadError(
          `Unsupported file type: ${f.type || 'unknown'} (${f.name}). Accepts PNG, JPEG, WebP, TIFF, BMP, or PDF.`,
        );
        return;
      }
    }
    setUploading(true);
    try {
      // v1.6 — single file uses the existing sync/async path; ≥2
      // files goes through the bulk endpoint.
      if (files.length === 1) {
        const job = await client.uploadRedact(files[0]!);
        setSelectedId(job.id);
        setSelectedBatchId(null);
      } else {
        const { batch, jobs } = await client.uploadRedactBatch(files);
        if (jobs.length > 0) setSelectedId(jobs[0]!.id);
        setSelectedBatchId(batch.id);
      }
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
      void handleFiles(Array.from(list));
    }
    e.target.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void handleFiles(files);
  };

  const selected = history.find((j) => j.id === selectedId) ?? null;
  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? null;

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

  const retryJob = async (id: string): Promise<void> => {
    try {
      const updated = await client.retryRedactJob(id);
      setSelectedId(updated.id);
      await refresh();
    } catch (e) {
      setUploadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'retry failed',
      );
    }
  };

  return (
    <div>
      <h2>Redact a document</h2>
      <p className="muted">
        Drop an image or a PDF; we'll run OCR + Presidio + face /
        signature / barcode detection page-by-page and give you back
        the redacted PDF, an extracted-text Markdown file, and a JSON
        token map. Cleartext stays on this appliance — only opaque
        tokens are sent if you later ship the result to Anthropic.
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
            {uploading ? 'Redacting…' : 'Drop one or more files here'}
          </p>
          <p className="muted" style={{ margin: '0 0 16px 0', fontSize: 13 }}>
            PNG, JPEG, WebP, TIFF, BMP, or PDF · up to 50 MB each · drop a folder for bulk
          </p>
          <button
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? 'Working…' : 'Or choose file(s)'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
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

      {selectedBatch !== null && (
        <BatchDetail
          batch={selectedBatch}
          client={client}
          onClose={() => setSelectedBatchId(null)}
          onUpdated={() => void refresh()}
        />
      )}

      {selected !== null && (
        <JobDetail
          job={selected}
          client={client}
          canUpload={canUpload}
          onUpdated={() => void refresh()}
          onRetry={() => void retryJob(selected.id)}
        />
      )}

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

function JobDetail({
  job,
  client,
  canUpload,
  onUpdated,
  onRetry,
}: {
  job: RedactJobRow;
  client: AdminClient;
  canUpload: boolean;
  onUpdated?: () => void;
  onRetry?: () => void;
}): JSX.Element {
  // v1.5 — live SSE progress for running (typically PDF) jobs.
  const [pagesDone, setPagesDone] = useState<number>(0);
  const [totalPages, setTotalPages] = useState<number | null>(
    job.pages_count,
  );
  useEffect(() => {
    if (job.status !== 'pending' && job.status !== 'running') return;
    const es = new EventSource(
      `${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/v1/redact/jobs/${job.id}/stream`,
      { withCredentials: true },
    );
    const onProgress = (e: MessageEvent): void => {
      try {
        const data = JSON.parse(e.data) as {
          page?: number;
          totalPages?: number;
        };
        if (typeof data.page === 'number') setPagesDone(data.page);
        if (typeof data.totalPages === 'number') setTotalPages(data.totalPages);
      } catch {
        // ignore
      }
    };
    es.addEventListener('page_completed', onProgress);
    es.addEventListener('page_started', onProgress);
    es.addEventListener('snapshot', onProgress);
    const close = (): void => {
      es.close();
      onUpdated?.();
    };
    es.addEventListener('job_completed', close);
    es.addEventListener('job_failed', close);
    es.onerror = (): void => {
      // Browser auto-reconnects on transient errors; we'll let it.
    };
    return () => {
      es.close();
    };

  }, [job.id, job.status]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: '0 0 4px 0' }}>{job.filename}</h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <code style={{ fontSize: 11 }}>{job.id}</code> · {job.mime} ·{' '}
            {formatBytes(job.source_size_bytes)}
            {totalPages !== null && totalPages > 0 && (
              <>
                {' · '}
                {totalPages.toString()} page{totalPages === 1 ? '' : 's'}
              </>
            )}
          </p>
        </div>
        <StatusPill status={job.status} />
      </div>

      {job.status === 'failed' && (
        <div style={{ marginTop: 16 }}>
          {job.error_message !== null && (
            <p className="error" style={{ margin: '0 0 12px 0' }}>
              {job.error_message}
            </p>
          )}
          {canUpload && (
            <button onClick={onRetry}>Retry redaction</button>
          )}
        </div>
      )}

      {(job.status === 'pending' || job.status === 'running') && (
        <div style={{ marginTop: 16 }}>
          {totalPages !== null && totalPages > 0 ? (
            <>
              <div
                style={{
                  background: '#e5e7eb',
                  borderRadius: 4,
                  height: 8,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    background: '#4f46e5',
                    height: '100%',
                    width: `${((pagesDone / totalPages) * 100).toFixed(0)}%`,
                    transition: 'width 220ms ease-out',
                  }}
                />
              </div>
              <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Page {pagesDone.toString()} of {totalPages.toString()}
              </p>
            </>
          ) : (
            <p className="muted">Redacting…</p>
          )}
        </div>
      )}

      {job.status === 'completed' && (
        <div style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: '0 0 8px 0', fontSize: 13 }}>
            Downloads:
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href={client.redactJobBundleUrl(job.id)} download>
              <button>Bundle (.zip)</button>
            </a>
            <a
              href={client.redactArtifactUrl(job.id, 'redacted')}
              download
            >
              <button className="secondary">Redacted PDF</button>
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
            Bundle includes all of the above plus a per-page PNG set and the
            audit log. Auto-expires {new Date(job.expires_at).toLocaleDateString()}.
            Artifacts are stored encrypted-at-rest on the appliance volume.
          </p>
        </div>
      )}
    </div>
  );
}

interface BatchDetailProps {
  batch: RedactBatchRow;
  client: AdminClient;
  onClose: () => void;
  onUpdated?: () => void;
}

function BatchDetail({
  batch,
  client,
  onClose,
  onUpdated,
}: BatchDetailProps): JSX.Element {
  const [summary, setSummary] = useState<
    Record<'pending' | 'running' | 'completed' | 'failed', number> | null
  >(null);
  const [childJobs, setChildJobs] = useState<RedactJobRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await client.getRedactBatch(batch.id);
        if (stopped) return;
        setSummary(res.summary);
        setChildJobs(res.jobs);
        setError(null);
        if (res.summary.pending === 0 && res.summary.running === 0) {
          onUpdated?.();
        }
      } catch (e) {
        if (stopped) return;
        setError(
          e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'batch fetch failed',
        );
      }
    };
    void tick();
    // Poll every 2s until every child job is terminal. The per-job
    // detail SSE drives the page-level progress bar; this is just the
    // batch-level aggregate.
    const interval = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [batch.id]);

  const total = batch.total_jobs;
  const done =
    summary === null ? 0 : summary.completed + summary.failed;
  const allTerminal =
    summary !== null && summary.pending === 0 && summary.running === 0;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <h3 style={{ margin: '0 0 4px 0' }}>
            Batch · {batch.name ?? `${total.toString()} files`}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <code style={{ fontSize: 11 }}>{batch.id}</code> · started{' '}
            {new Date(batch.created_at).toLocaleString()}
          </p>
        </div>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div
          style={{
            background: '#e5e7eb',
            borderRadius: 4,
            height: 8,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              background: allTerminal ? '#10b981' : '#4f46e5',
              height: '100%',
              width: `${((done / total) * 100).toFixed(0)}%`,
              transition: 'width 220ms ease-out',
            }}
          />
        </div>
        {summary !== null && (
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {summary.completed.toString()} done · {summary.failed.toString()} failed ·{' '}
            {summary.running.toString()} running · {summary.pending.toString()} pending
          </p>
        )}
      </div>

      {error !== null && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

      {allTerminal && summary !== null && summary.completed > 0 && (
        <div style={{ marginTop: 16 }}>
          <a href={client.redactBatchBundleUrl(batch.id)} download>
            <button>Download all completed (.zip)</button>
          </a>
        </div>
      )}

      {childJobs.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            Per-file status
          </summary>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Status</th>
                <th>Pages</th>
              </tr>
            </thead>
            <tbody>
              {childJobs.map((j) => (
                <tr key={j.id}>
                  <td style={{ fontSize: 13 }}>{j.filename}</td>
                  <td>
                    <StatusPill status={j.status} />
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {j.pages_count ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
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
