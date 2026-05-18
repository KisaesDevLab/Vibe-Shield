import type { ViewName } from '../App.js';
import type { MeResponse } from '../api.js';

interface Props {
  active: ViewName;
  onSelect: (v: ViewName) => void;
  onLogout: () => void;
  me: MeResponse;
}

interface Item {
  id: ViewName;
  label: string;
  /** Hidden when this returns false. */
  visible?: (me: MeResponse) => boolean;
}

const items: Item[] = [
  { id: 'keys', label: 'API Keys' },
  { id: 'audit', label: 'Audit Log' },
  { id: 'misses', label: 'Recognizer Misses' },
  { id: 'probe', label: 'Anthropic Probe' },
  { id: 'policies', label: 'Policies' },
  { id: 'prompts', label: 'Prompt Templates' },
  { id: 'users', label: 'Users', visible: (me) => me.is_org_admin },
];

export function Sidebar({ active, onSelect, onLogout, me }: Props): JSX.Element {
  const visibleItems = items.filter((it) => it.visible?.(me) ?? true);
  return (
    <aside className="sidebar">
      <h1>Vibe Shield</h1>
      <nav>
        {visibleItems.map((it) => (
          <a
            key={it.id}
            href="#"
            className={active === it.id ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              onSelect(it.id);
            }}
          >
            {it.label}
          </a>
        ))}
      </nav>
      <div style={{ marginTop: 24 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Signed in as
          <br />
          <strong style={{ color: 'inherit' }}>{me.email}</strong>
          {me.is_org_admin && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10,
                padding: '1px 5px',
                background: '#444',
                borderRadius: 3,
              }}
            >
              org admin
            </span>
          )}
        </div>
        <button className="secondary" onClick={onLogout} style={{ width: '100%' }}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
