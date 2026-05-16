import type { ViewName } from '../App.js';

interface Props {
  active: ViewName;
  onSelect: (v: ViewName) => void;
  onLogout: () => void;
}

const items: { id: ViewName; label: string }[] = [
  { id: 'keys', label: 'API Keys' },
  { id: 'audit', label: 'Audit Log' },
  { id: 'misses', label: 'Recognizer Misses' },
  { id: 'probe', label: 'Anthropic Probe' },
  { id: 'policies', label: 'Policies' },
];

export function Sidebar({ active, onSelect, onLogout }: Props): JSX.Element {
  return (
    <aside className="sidebar">
      <h1>Vibe Shield</h1>
      <nav>
        {items.map((it) => (
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
        <button className="secondary" onClick={onLogout} style={{ width: '100%' }}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
