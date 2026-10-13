import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { requestJson } from './api.js';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Rundowns of the signed-in account and the current one (what My Graphics, the renderer and the API work with).
export function useRundowns(account) {
  const [rundowns, setRundowns] = useState([]);
  const [currentRundownId, setCurrentRundownId] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!account) { setRundowns([]); setCurrentRundownId(null); return; }
    try {
      const response = await requestJson('/api/rundowns');
      setRundowns(response.rundowns ?? []);
      setCurrentRundownId(response.currentRundownId ?? null);
      setError('');
    } catch (failure) { setError(failure.message); }
  }, [account]);
  useEffect(() => { void reload(); }, [reload]);
  async function create(name) {
    const { rundown } = await requestJson('/api/rundowns', json('POST', { name }));
    setRundowns((current) => [...current, rundown]);
    return rundown;
  }
  async function rename(rundownId, name) {
    await requestJson(`/api/rundowns/${encodeURIComponent(rundownId)}`, json('PATCH', { name }));
    setRundowns((current) => current.map((rundown) => rundown.id === rundownId ? { ...rundown, name } : rundown));
  }
  async function remove(rundownId) {
    await requestJson(`/api/rundowns/${encodeURIComponent(rundownId)}`, { method: 'DELETE' });
    setRundowns((current) => current.filter((rundown) => rundown.id !== rundownId));
  }
  async function switchTo(rundownId, force = false) {
    await requestJson('/api/rundowns/current', json('PUT', { rundownId, force }));
    setCurrentRundownId(rundownId);
  }
  const current = rundowns.find((rundown) => rundown.id === currentRundownId) ?? null;
  return { rundowns, currentRundownId, current, error, reload, create, rename, remove, switchTo };
}

function NameForm({ initial = '', label, submitLabel, onSubmit, onCancel }) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  async function submit(event) {
    event.preventDefault();
    const value = name.trim();
    if (!value || saving) return;
    setSaving(true);
    setError('');
    try { await onSubmit(value); }
    catch (failure) { setError(failure.message); setSaving(false); }
  }
  return <form className="rundown-form" onSubmit={submit} onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.preventDefault(); onCancel(); } }}>
    <div className="rundown-form-row">
      <input ref={input} aria-label={label} value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} />
      <button className="icon-button" type="submit" disabled={saving || !name.trim()} aria-label={submitLabel} title={submitLabel}><Check size={15} /></button>
      <button className="icon-button" type="button" disabled={saving} onClick={onCancel} aria-label="Cancel" title="Cancel"><X size={15} /></button>
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
  </form>;
}

// Sidebar list of rundowns: switch by clicking, create with "+", rename with the pencil, delete with the trash can
// (not offered for the current rundown).
export function RundownPanel({ state, onSwitched, onDeleted = () => {} }) {
  const headingId = useId();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  async function switchTo(rundown, force = false) {
    if (switching || rundown.id === state.currentRundownId) return;
    setSwitching(true);
    setError('');
    try {
      await state.switchTo(rundown.id, force);
      setConfirm(null);
      onSwitched(rundown);
    } catch (failure) {
      if (failure.payload?.code === 'ON_AIR') setConfirm({ rundown, message: failure.message });
      else setError(failure.message);
    } finally { setSwitching(false); }
  }
  async function remove(rundown) {
    setBusy(true);
    setError('');
    try {
      await state.remove(rundown.id);
      setDeleting(null);
      onDeleted(rundown);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <section className="rundown-panel" aria-labelledby={headingId}>
    <div className="sidebar-heading-row">
      <h2 id={headingId} className="sidebar-heading">Rundowns</h2>
      <button className="icon-button" type="button" onClick={() => { setCreating(true); setRenaming(null); }} disabled={creating}
        aria-label="New rundown" title="New rundown"><Plus size={15} /></button>
    </div>
    {creating && <NameForm label="New rundown name" submitLabel="Create rundown" onCancel={() => setCreating(false)}
      onSubmit={async (name) => { await state.create(name); setCreating(false); }} />}
    <ul className="rundown-list">
      {state.rundowns.map((rundown) => <li key={rundown.id}>
        {renaming === rundown.id
          ? <NameForm initial={rundown.name} label="Rundown name" submitLabel="Save name" onCancel={() => setRenaming(null)}
            onSubmit={async (name) => { await state.rename(rundown.id, name); setRenaming(null); }} />
          : <div className="rundown-item">
            <button className="rundown-switch" type="button" onClick={() => switchTo(rundown)} disabled={switching}
              aria-current={rundown.id === state.currentRundownId ? 'true' : undefined}
              title={rundown.id === state.currentRundownId ? 'Current rundown' : `Switch to ${rundown.name}`}>
              <span className="rundown-name">{rundown.name}</span><span className="entry-count">{rundown.entryCount}</span>
            </button>
            <button className="icon-button rundown-rename" type="button" onClick={() => { setRenaming(rundown.id); setCreating(false); }}
              aria-label={`Rename ${rundown.name}`} title="Rename"><Pencil size={13} /></button>
            {rundown.id !== state.currentRundownId && <button className="icon-button rundown-rename rundown-delete" type="button"
              onClick={() => { setDeleting(rundown); setConfirm(null); }} aria-label={`Delete ${rundown.name}`} title="Delete"><Trash2 size={13} /></button>}
          </div>}
      </li>)}
    </ul>
    {confirm && <div className="token-confirm" role="group" aria-label="Confirm rundown switch">
      <p>{confirm.message}. Switching to {confirm.rundown.name} takes them off air.</p>
      <div className="renderer-actions">
        <button className="text-button" type="button" onClick={() => setConfirm(null)} disabled={switching}>Cancel</button>
        <button className="danger-button" type="button" onClick={() => switchTo(confirm.rundown, true)} disabled={switching}>Switch</button>
      </div>
    </div>}
    {deleting && <div className="token-confirm" role="group" aria-label="Confirm rundown deletion">
      <p>Delete {deleting.name}{deleting.entryCount ? ` and its ${deleting.entryCount} graphic${deleting.entryCount === 1 ? '' : 's'}` : ''}? This cannot be undone.</p>
      <div className="renderer-actions">
        <button className="text-button" type="button" onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
        <button className="danger-button" type="button" onClick={() => remove(deleting)} disabled={busy}>Delete</button>
      </div>
    </div>}
    {(error || state.error) && <p className="error-message" role="alert">{error || state.error}</p>}
  </section>;
}
