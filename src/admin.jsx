import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { requestJson } from './api.js';

const providerNames = { twitch: 'Twitch', google: 'YouTube' };
const formatDate = (value) => (value ? new Date(value).toLocaleDateString() : '');

// Admins only: every account with its sign-in, role and what it has created.
export default function UsersView({ account, authLoading }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const admin = Boolean(account?.is_approver);
  useEffect(() => {
    if (!admin) return undefined;
    const controller = new AbortController();
    requestJson('/api/admin/users', { signal: controller.signal })
      .then((response) => { setUsers(response.users ?? []); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [admin]);

  return <section className="users-view" aria-labelledby="users-heading">
    <p className="eyebrow">ADMINISTRATION</p>
    <h1 id="users-heading">Users</h1>
    {authLoading ? <p className="status" role="status">Loading account...</p>
      : !admin ? <div className="empty-state"><strong>Admins only.</strong><span>This page is available to accounts listed in ADMIN_USERS.</span></div>
        : error ? <p className="error-message" role="alert">{error}</p>
          : !users ? <p className="status" role="status">Loading users...</p>
            : <>
              <p className="renderer-lead">{users.length} account{users.length === 1 ? '' : 's'}. Twitch and YouTube sign-ins are separate accounts.</p>
              <div className="users-table-wrap">
                <table className="users-table">
                  <thead><tr>
                    <th scope="col">Name</th><th scope="col">Sign-in</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col">Last sign-in</th>
                    <th scope="col" className="number">Rundowns</th><th scope="col" className="number">Entries</th>
                    <th scope="col" className="number" title="Private graphics">Uploads</th><th scope="col" className="number">Media</th>
                  </tr></thead>
                  <tbody>{users.map((user) => <tr key={user.id}>
                    <th scope="row">{user.displayName}{user.id === String(account.id) && <span className="users-you"> (you)</span>}</th>
                    <td>{providerNames[user.provider] ?? user.provider}{user.login && <span className="users-login"> @{user.login}</span>}</td>
                    <td>{user.isAdmin ? <span className="role-badge"><ShieldCheck size={14} aria-hidden="true" />Admin</span> : 'User'}</td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>{formatDate(user.lastSignIn)}</td>
                    <td className="number">{user.rundowns}</td>
                    <td className="number">{user.entries}</td>
                    <td className="number">{user.privateGraphics}</td>
                    <td className="number">{user.media}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </>}
  </section>;
}
