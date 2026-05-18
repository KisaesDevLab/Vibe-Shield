import { useEffect, useState } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type AnthropicKeyStatus,
  type AnthropicProbeResult,
} from '../api.js';

interface Props {
  client: AdminClient;
}

/**
 * Anthropic key management — Phase 23.5.
 *
 * Three panels stacked top-to-bottom:
 *   1. Current key status — source badge, fingerprint, set-at, last
 *      probe result.
 *   2. Set / rotate key — the textarea + Validate & save button.
 *   3. Revert to env-backed key — danger button, disabled when source
 *      is already env.
 *
 * Hard rule: the plaintext key never lives in component state longer
 * than necessary. On submit success we immediately clear the textarea
 * and the local ``draft`` state so a stray React DevTools session can't
 * surface it.
 */
export function AnthropicProbeView({ client }: Props): JSX.Element {
  const [status, setStatus] = useState<AnthropicKeyStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<AnthropicProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const refreshStatus = async (): Promise<void> => {
    try {
      setStatus(await client.getAnthropicKeyStatus());
      setStatusError(null);
    } catch (e) {
      setStatusError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'status load failed',
      );
    }
  };

  useEffect(() => {
    void refreshStatus();

  }, []);

  const probe = async (): Promise<void> => {
    setRunning(true);
    setProbeError(null);
    try {
      setProbeResult(await client.reprobeAnthropic());
    } catch (e) {
      setProbeError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'probe failed',
      );
    } finally {
      setRunning(false);
    }
  };

  const save = async (): Promise<void> => {
    const candidate = draft.trim();
    if (candidate.length === 0) {
      setSaveError('Enter the new commercial Anthropic key.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const fresh = await client.setAnthropicKey(candidate);
      // Clear the draft IMMEDIATELY — never let plaintext linger.
      setDraft('');
      setStatus(fresh);
      setSaveOk(
        fresh.fingerprint !== null
          ? `Saved. New fingerprint: ${fresh.fingerprint}`
          : 'Saved.',
      );
      setProbeResult(null);
    } catch (e) {
      setSaveError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'save failed',
      );
    } finally {
      setSaving(false);
    }
  };

  const revertToEnv = async (): Promise<void> => {
    if (
      !window.confirm(
        'Revert to the env-backed Anthropic key? This clears the admin-set key.',
      )
    ) {
      return;
    }
    setClearing(true);
    setClearError(null);
    try {
      await client.clearAnthropicKey();
      await refreshStatus();
      setProbeResult(null);
    } catch (e) {
      setClearError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'revert failed',
      );
    } finally {
      setClearing(false);
    }
  };

  const sourceLabel =
    status === null
      ? '…'
      : status.source === 'db'
        ? `Set by admin${status.set_at !== null ? ` on ${new Date(status.set_at).toLocaleString()}` : ''}`
        : 'From env (bootstrap)';

  const revertDisabled =
    status === null ||
    status.source === 'env' ||
    status.bootstrap_present === false ||
    clearing;

  return (
    <div>
      <h2>Anthropic API Key</h2>
      <p className="muted">
        The gateway uses this commercial Anthropic API key for every
        outbound call. The env-set <code>ANTHROPIC_API_KEY</code> is the
        bootstrap; setting a key here persists it encrypted under the
        appliance KEK and overrides the env value on the next request.
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Current key</h3>
        {statusError !== null && <p className="error">{statusError}</p>}
        {status !== null && (
          <dl style={{ margin: 0 }}>
            <dt>Source</dt>
            <dd>{sourceLabel}</dd>
            <dt>Fingerprint</dt>
            <dd>
              {status.fingerprint !== null ? (
                <code>{status.fingerprint}</code>
              ) : (
                <span className="muted">none</span>
              )}
            </dd>
          </dl>
        )}
        <div style={{ marginTop: 16 }}>
          <button onClick={() => void probe()} disabled={running}>
            {running ? 'Probing…' : 'Run probe now'}
          </button>
          {probeError !== null && (
            <p className="error" style={{ marginTop: 16 }}>
              {probeError}
            </p>
          )}
          {probeResult !== null && (
            <div style={{ marginTop: 16 }}>
              {probeResult.ok ? (
                <p className="success">
                  ✓ Probe succeeded
                  {probeResult.models_visible !== undefined
                    ? `. ${probeResult.models_visible} model(s) visible.`
                    : '.'}
                </p>
              ) : (
                <p className="error">✗ Probe failed: {probeResult.reason}</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Set / rotate key</h3>
        <p className="muted">
          Paste a commercial API key (consumer keys are rejected). The
          gateway probes Anthropic before saving — a bad key never
          touches the database.
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="sk-ant-…"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          disabled={saving}
        />
        <div style={{ marginTop: 8 }}>
          <button onClick={() => void save()} disabled={saving || draft.length === 0}>
            {saving ? 'Validating…' : 'Validate & save'}
          </button>
          {saveError !== null && (
            <p className="error" style={{ marginTop: 16 }}>
              {saveError}
            </p>
          )}
          {saveOk !== null && (
            <p className="success" style={{ marginTop: 16 }}>
              {saveOk}
            </p>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Revert to env-backed key</h3>
        <p className="muted">
          Clears the admin-set key so the gateway falls back to{' '}
          <code>ANTHROPIC_API_KEY</code> from the appliance environment.
          Disabled when the active key is already env-backed, or when no
          env key is set (refusing to clear would leave the gateway with
          no credentials).
        </p>
        <button
          onClick={() => void revertToEnv()}
          disabled={revertDisabled}
          className="danger"
        >
          {clearing ? 'Reverting…' : 'Revert to env-backed key'}
        </button>
        {clearError !== null && (
          <p className="error" style={{ marginTop: 16 }}>
            {clearError}
          </p>
        )}
      </div>
    </div>
  );
}
