import { useState, type FormEvent } from 'react';

interface Props {
  onLogin: (adminKey: string) => void;
}

/**
 * Holds the admin key in a controlled input. On submit, hands it to
 * the parent which constructs an AdminClient. The key never lands in
 * localStorage / sessionStorage — refresh = re-prompt. Same posture as
 * a per-page admin login.
 */
export function LoginGate({ onLogin }: Props): JSX.Element {
  const [key, setKey] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (key.trim().length > 0) onLogin(key.trim());
  };
  return (
    <div style={{ maxWidth: 360, margin: '120px auto' }}>
      <div className="card">
        <h1 style={{ margin: '0 0 8px 0' }}>Vibe Shield Admin</h1>
        <p className="muted" style={{ margin: '0 0 16px 0' }}>
          Enter your admin API key to continue.
        </p>
        <form onSubmit={submit}>
          <input
            type="password"
            placeholder="sk-vs-admin-..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ width: '100%', marginBottom: 12 }}
            autoComplete="off"
          />
          <button type="submit" style={{ width: '100%' }}>
            Sign in
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          Keys are held in memory only. Refresh to clear.
        </p>
      </div>
    </div>
  );
}
