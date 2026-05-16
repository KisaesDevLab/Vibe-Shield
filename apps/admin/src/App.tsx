import { useState } from 'react';

import { AdminClient } from './api.js';
import { LoginGate } from './views/LoginGate.js';
import { Sidebar } from './views/Sidebar.js';
import { ApiKeysView } from './views/ApiKeysView.js';
import { AuditView } from './views/AuditView.js';
import { RecognizerMissesView } from './views/RecognizerMissesView.js';
import { AnthropicProbeView } from './views/AnthropicProbeView.js';
import { PoliciesView } from './views/PoliciesView.js';

export type ViewName = 'keys' | 'audit' | 'misses' | 'probe' | 'policies';

export function App(): JSX.Element {
  const [client, setClient] = useState<AdminClient | null>(null);
  const [view, setView] = useState<ViewName>('keys');

  if (client === null) {
    return <LoginGate onLogin={(k) => setClient(new AdminClient(k))} />;
  }

  return (
    <div className="layout">
      <Sidebar active={view} onSelect={setView} onLogout={() => setClient(null)} />
      <main className="content">
        {view === 'keys' && <ApiKeysView client={client} />}
        {view === 'audit' && <AuditView client={client} />}
        {view === 'misses' && <RecognizerMissesView client={client} />}
        {view === 'probe' && <AnthropicProbeView client={client} />}
        {view === 'policies' && <PoliciesView client={client} />}
      </main>
    </div>
  );
}
