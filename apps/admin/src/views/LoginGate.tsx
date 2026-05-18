import { useState, type FormEvent } from 'react';

import { AdminApiError, AdminClient } from '../api.js';

interface Props {
  onAdminKey: (adminKey: string) => void;
}

/**
 * Sign-in screen offering two paths:
 *
 *   1. Magic link (default) — operator enters their email; the gateway
 *      emails a one-time link that, when clicked, lands on
 *      /api/auth/consume and sets the vs_session cookie. The SPA reloads
 *      and shows the authenticated UI.
 *
 *   2. Admin key (fallback) — paste the GATEWAY_ADMIN_KEY. Used for
 *      first-boot bootstrap, or when SMTP isn't configured. Same
 *      in-memory model as v1.1: refresh = re-prompt.
 *
 * If SMTP is not configured the magic-link form surfaces a 503 on
 * submit; we let the user fall back to the admin-key path explicitly.
 */
export function LoginGate({ onAdminKey }: Props): JSX.Element {
  const [mode, setMode] = useState<'magic' | 'key'>('magic');
  return (
    <div style={{ maxWidth: 420, margin: '120px auto' }}>
      <div className="card">
        <h1 style={{ margin: '0 0 8px 0' }}>Vibe Shield Admin</h1>
        <p className="muted" style={{ margin: '0 0 16px 0' }}>
          {mode === 'magic'
            ? 'Sign in with a one-time link sent to your email.'
            : 'Paste the appliance admin key.'}
        </p>
        {mode === 'magic' ? <MagicLinkForm /> : <AdminKeyForm onAdminKey={onAdminKey} />}
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          {mode === 'magic' ? (
            <>
              Don&apos;t have email set up?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode('key');
                }}
              >
                Use admin key instead
              </a>
            </>
          ) : (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setMode('magic');
              }}
            >
              ← Back to magic link
            </a>
          )}
        </p>
      </div>
    </div>
  );
}

function MagicLinkForm(): JSX.Element {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    setSending(true);
    setError(null);
    try {
      // Anonymous client — sends only the request-link call. No auth headers.
      const anon = new AdminClient();
      await anon.requestMagicLink(trimmed);
      setSent(true);
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 501) {
        setError(
          'Magic-link sign-in is not configured on this appliance. Use the admin key instead.',
        );
      } else {
        setError(
          e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'Send failed',
        );
      }
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <p className="success">
        ✓ If <code>{email}</code> belongs to a user, a sign-in link is on its
        way. Check your inbox — links expire in 15 minutes.
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <input
        type="email"
        placeholder="you@firm.example"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        style={{ width: '100%', marginBottom: 12 }}
        required
      />
      <button
        type="submit"
        style={{ width: '100%' }}
        disabled={sending || email.trim().length === 0}
      >
        {sending ? 'Sending…' : 'Send magic link'}
      </button>
      {error !== null && (
        <p className="error" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
    </form>
  );
}

function AdminKeyForm({ onAdminKey }: { onAdminKey: (k: string) => void }): JSX.Element {
  const [key, setKey] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (key.trim().length > 0) onAdminKey(key.trim());
  };
  return (
    <form onSubmit={submit}>
      <input
        type="password"
        placeholder="vs-admin-…"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        style={{ width: '100%', marginBottom: 12 }}
        autoComplete="off"
      />
      <button type="submit" style={{ width: '100%' }}>
        Sign in
      </button>
    </form>
  );
}
