import { useState } from 'react';

import { AdminApiError, type AdminClient, type AnthropicProbeResult } from '../api.js';

interface Props {
  client: AdminClient;
}

export function AnthropicProbeView({ client }: Props): JSX.Element {
  const [result, setResult] = useState<AnthropicProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const probe = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      setResult(await client.reprobeAnthropic());
    } catch (e) {
      setError(e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'probe failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <h2>Anthropic Commercial-Key Probe</h2>
      <p className="muted">
        Re-runs the startup commercial-key probe against the configured Anthropic key.
        Use after rotating the key to confirm the gateway sees the new value.
      </p>

      <div className="card">
        <button onClick={() => void probe()} disabled={running}>
          {running ? 'Probing…' : 'Run probe now'}
        </button>
        {error !== null && <p className="error" style={{ marginTop: 16 }}>{error}</p>}
        {result !== null && (
          <div style={{ marginTop: 16 }}>
            {result.ok ? (
              <p className="success">
                ✓ Probe succeeded. {result.models_visible} model(s) visible.
              </p>
            ) : (
              <p className="error">✗ Probe failed: {result.reason}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
