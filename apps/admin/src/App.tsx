import { useEffect, useState } from 'react';

import { AdminApiError, AdminClient, type MeResponse } from './api.js';
import { LoginGate } from './views/LoginGate.js';
import { Sidebar } from './views/Sidebar.js';
import { ApiKeysView } from './views/ApiKeysView.js';
import { AuditView } from './views/AuditView.js';
import { RecognizerMissesView } from './views/RecognizerMissesView.js';
import { AnthropicProbeView } from './views/AnthropicProbeView.js';
import { PoliciesView } from './views/PoliciesView.js';
import { PromptsView } from './views/PromptsView.js';
import { RedactView } from './views/RedactView.js';
import { ScanView } from './views/ScanView.js';
import { ScheduledScansView } from './views/ScheduledScansView.js';
import { UsersView } from './views/UsersView.js';

export type ViewName =
  | 'redact'
  | 'scan'
  | 'scheduled-scans'
  | 'keys'
  | 'audit'
  | 'misses'
  | 'probe'
  | 'policies'
  | 'prompts'
  | 'users';

/**
 * App entry. Resolution order at load:
 *
 *   1. Try GET /api/auth/me via the session cookie. If it works,
 *      we're signed in via magic-link → hydrate the authenticated UI.
 *   2. Otherwise show LoginGate, which offers magic-link request OR
 *      legacy admin-key paste.
 *   3. Admin-key path constructs an AdminClient with the X-Admin-Key
 *      header attached; subsequent /api/auth/me will still 401 (we
 *      never created a session), so we synthesize a minimal "session"
 *      record locally to keep the UI happy.
 */
export function App(): JSX.Element {
  const [client, setClient] = useState<AdminClient | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [resolving, setResolving] = useState(true);
  const [view, setView] = useState<ViewName>('redact');

  // Initial session probe. Cookie-based; no headers needed.
  useEffect(() => {
    const probe = async (): Promise<void> => {
      try {
        const anon = new AdminClient();
        const m = await anon.me();
        setClient(anon);
        setMe(m);
      } catch (e) {
        if (!(e instanceof AdminApiError) || e.status !== 401) {
          // Network or unexpected — still drop to LoginGate; the user
          // can retry from there.
        }
      } finally {
        setResolving(false);
      }
    };
    void probe();
  }, []);

  if (resolving) {
    return <div style={{ margin: 120, textAlign: 'center' }} className="muted">…</div>;
  }

  if (client === null || me === null) {
    return (
      <LoginGate
        onAdminKey={(k) => {
          const c = new AdminClient(k);
          setClient(c);
          // Synthesize a minimal "me" record for the admin-key path.
          // Admin-key bypasses the user model entirely — treat it as
          // an org_admin without a real user record.
          setMe({
            id: 'admin-key',
            email: 'admin-key@appliance',
            is_org_admin: true,
            roles: { redact: 'admin', scan: 'admin', compliance: 'admin' },
            mailer_configured: false,
          });
        }}
      />
    );
  }

  const logout = async (): Promise<void> => {
    try {
      await client.logout();
    } catch {
      // Best-effort. Even if logout fails server-side, drop local state.
    }
    setClient(null);
    setMe(null);
    // Force a reload to clear any cached state and re-run the cookie
    // probe (which will now 401, dropping back to LoginGate).
    window.location.reload();
  };

  return (
    <div className="layout">
      <Sidebar
        active={view}
        onSelect={setView}
        onLogout={() => void logout()}
        me={me}
      />
      <main className="content">
        {view === 'redact' && <RedactView client={client} me={me} />}
        {view === 'scan' && <ScanView client={client} me={me} />}
        {view === 'scheduled-scans' && (
          <ScheduledScansView client={client} me={me} />
        )}
        {view === 'keys' && <ApiKeysView client={client} />}
        {view === 'audit' && <AuditView client={client} />}
        {view === 'misses' && <RecognizerMissesView client={client} />}
        {view === 'probe' && <AnthropicProbeView client={client} />}
        {view === 'policies' && <PoliciesView client={client} />}
        {view === 'prompts' && <PromptsView client={client} />}
        {view === 'users' && me.is_org_admin && <UsersView client={client} />}
      </main>
    </div>
  );
}
