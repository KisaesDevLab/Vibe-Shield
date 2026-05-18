import { useEffect, useState, type FormEvent } from 'react';

import {
  AdminApiError,
  type AdminClient,
  type ModuleName,
  type RoleName,
  type UserRow,
} from '../api.js';

interface Props {
  client: AdminClient;
}

const MODULES: ModuleName[] = ['redact', 'scan', 'compliance'];
const ROLES: RoleName[] = ['viewer', 'operator', 'admin'];

/**
 * Users + per-module RBAC management. Visible only to org_admin (the
 * parent component guards this). Lets the operator invite new users
 * (sending a magic-link email if SMTP is configured), set or revoke
 * roles per module, toggle is_org_admin, and disable accounts.
 */
export function UsersView({ client }: Props): JSX.Element {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteOrgAdmin, setInviteOrgAdmin] = useState(false);
  const [inviteRoles, setInviteRoles] = useState<Partial<Record<ModuleName, RoleName>>>({});
  const [inviting, setInviting] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setRows(await client.listUsers());
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'load failed',
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, [client]);

  const invite = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (inviteEmail.trim().length === 0) return;
    setInviting(true);
    setInviteStatus(null);
    try {
      const result = await client.inviteUser({
        email: inviteEmail.trim(),
        isOrgAdmin: inviteOrgAdmin,
        roles: inviteRoles,
      });
      setInviteStatus(
        result.invited
          ? `Invited ${result.email}; magic-link email sent.`
          : `Created ${result.email}; SMTP not configured — share the appliance admin key with them.`,
      );
      setInviteEmail('');
      setInviteOrgAdmin(false);
      setInviteRoles({});
      await refresh();
    } catch (e) {
      setInviteStatus(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'invite failed',
      );
    } finally {
      setInviting(false);
    }
  };

  const setRole = async (
    userId: string,
    module: ModuleName,
    role: RoleName | '',
  ): Promise<void> => {
    try {
      if (role === '') {
        await client.revokeUserRole(userId, module);
      } else {
        await client.setUserRole(userId, module, role);
      }
      await refresh();
    } catch (e) {
      setLoadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'role change failed',
      );
    }
  };

  const toggleOrgAdmin = async (userId: string, value: boolean): Promise<void> => {
    try {
      await client.setUserOrgAdmin(userId, value);
      await refresh();
    } catch (e) {
      setLoadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'org-admin toggle failed',
      );
    }
  };

  const disable = async (userId: string): Promise<void> => {
    if (!window.confirm('Disable this user? They will no longer be able to sign in.')) {
      return;
    }
    try {
      await client.disableUser(userId);
      await refresh();
    } catch (e) {
      setLoadError(
        e instanceof AdminApiError ? `${e.status}: ${e.message}` : 'disable failed',
      );
    }
  };

  return (
    <div>
      <h2>Users</h2>
      <p className="muted">
        Manage admin users and their per-module roles. Inviting a user
        sends a one-time sign-in link to their email when SMTP is
        configured.
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0 }}>Invite</h3>
        <form onSubmit={(e) => void invite(e)}>
          <input
            type="email"
            placeholder="user@firm.example"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            style={{ width: '100%', marginBottom: 12 }}
            required
            disabled={inviting}
          />
          <label style={{ display: 'block', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={inviteOrgAdmin}
              onChange={(e) => setInviteOrgAdmin(e.target.checked)}
              disabled={inviting}
            />{' '}
            Make org admin (bypasses per-module RBAC)
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
            {MODULES.map((m) => (
              <label key={m}>
                <div style={{ fontSize: 12, textTransform: 'capitalize', marginBottom: 4 }}>{m}</div>
                <select
                  value={inviteRoles[m] ?? ''}
                  onChange={(e) =>
                    setInviteRoles({
                      ...inviteRoles,
                      [m]: e.target.value === '' ? undefined : (e.target.value as RoleName),
                    })
                  }
                  disabled={inviting}
                  style={{ width: '100%' }}
                >
                  <option value="">— no access —</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={inviting || inviteEmail.trim().length === 0}
          >
            {inviting ? 'Sending…' : 'Invite user'}
          </button>
          {inviteStatus !== null && (
            <p style={{ marginTop: 12 }} className={inviteStatus.startsWith('Invited') || inviteStatus.startsWith('Created') ? 'success' : 'error'}>
              {inviteStatus}
            </p>
          )}
        </form>
      </div>

      {loadError !== null && <p className="error">{loadError}</p>}

      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Org admin</th>
            {MODULES.map((m) => (
              <th key={m} style={{ textTransform: 'capitalize' }}>{m}</th>
            ))}
            <th>Last login</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} style={u.disabled_at !== null ? { opacity: 0.5 } : undefined}>
              <td>{u.email}</td>
              <td>
                <input
                  type="checkbox"
                  checked={u.is_org_admin}
                  onChange={(e) => void toggleOrgAdmin(u.id, e.target.checked)}
                  disabled={u.disabled_at !== null}
                />
              </td>
              {MODULES.map((m) => (
                <td key={m}>
                  <select
                    value={u.roles[m] ?? ''}
                    onChange={(e) =>
                      void setRole(
                        u.id,
                        m,
                        e.target.value === '' ? '' : (e.target.value as RoleName),
                      )
                    }
                    disabled={u.disabled_at !== null}
                  >
                    <option value="">—</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
              ))}
              <td className="muted" style={{ fontSize: 12 }}>
                {u.last_login_at !== null
                  ? new Date(u.last_login_at).toLocaleString()
                  : 'never'}
              </td>
              <td>
                {u.disabled_at !== null ? <span className="muted">disabled</span> : 'active'}
              </td>
              <td>
                {u.disabled_at === null && (
                  <button
                    className="danger"
                    onClick={() => void disable(u.id)}
                    style={{ fontSize: 12 }}
                  >
                    Disable
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
