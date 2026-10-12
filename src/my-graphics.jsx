import React, { useEffect, useId, useRef, useState } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { FileJson, MoreHorizontal, Play, RefreshCw, Save, SlidersHorizontal, Square, Trash2, X } from 'lucide-react';
import { canControlGraphic } from './api.js';

class PropertyFormBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error ? <p role="alert">This graphic has an unsupported property schema.</p> : this.props.children;
  }
}

export function PropertiesDialog({ entry, onSave, onClose }) {
  const dialog = useRef(null);
  const headingId = useId();
  const [data, setData] = useState(entry.schemaData ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  async function saveProperties({ formData }) {
    setSaving(true);
    setError('');
    try { await onSave(entry.entryId, { schemaData: formData }); onClose(); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  return (
    <dialog ref={dialog} className="properties-dialog" aria-labelledby={headingId} onCancel={(event) => {
      if (saving) event.preventDefault(); else onClose();
    }}>
      <header className="dialog-heading">
        <div><h2 id={headingId}>Properties</h2><p>{entry.label || entry.display_name} <span>v{entry.versionLabel}</span></p></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close properties" title="Close properties"><X size={18} /></button>
      </header>
      <div className="dialog-content">
        {error && <p role="alert" className="error-message">{error}</p>}
        <PropertyFormBoundary>
          <Form schema={entry.schema} validator={validator} formData={data} onChange={(event) => setData(event.formData)}
            onSubmit={saveProperties} disabled={saving} noHtml5Validate>
            <div className="dialog-actions">
              <button className="text-button" type="button" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="primary-button" type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save properties'}</button>
            </div>
          </Form>
        </PropertyFormBoundary>
      </div>
    </dialog>
  );
}

function EntryMenu({ entry, busy, onDelete, onManifest }) {
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const closeOutside = (event) => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('focusin', closeOutside); };
  }, [open]);
  function choose(callback) {
    setOpen(false);
    trigger.current?.focus();
    callback(entry);
  }
  return <div className="entry-menu" ref={container} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(menu.current.querySelectorAll('button'));
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}>
    <button ref={trigger} className="icon-button" type="button" disabled={busy} onClick={() => setOpen(!open)}
      aria-label={`More options for ${entry.label || entry.display_name}`} title="More options" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}><MoreHorizontal size={19} /></button>
    {open && <div ref={menu} id={menuId} className="entry-menu-popup" role="menu" aria-label="Graphic options">
      <button type="button" role="menuitem" onClick={() => choose(onManifest)}><FileJson size={16} />Show manifest</button>
      <button className="danger-menu-item" type="button" role="menuitem" onClick={() => choose(onDelete)}><Trash2 size={16} />Delete</button>
    </div>}
  </div>;
}

function EntryDialog({ entry, mode, onDelete, onManifest, onClose }) {
  const dialog = useRef(null);
  const headingId = useId();
  const [manifest, setManifest] = useState(null);
  const [loading, setLoading] = useState(mode === 'manifest');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    if (mode !== 'manifest') return;
    let active = true;
    async function load() {
      try { const result = await onManifest(entry); if (active) setManifest(result); }
      catch (failure) { if (active) setError(failure.message); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [entry, mode, onManifest]);
  async function remove() {
    setDeleting(true);
    setError('');
    try { await onDelete(entry); onClose(); }
    catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  }
  return <dialog ref={dialog} className="properties-dialog" aria-labelledby={headingId} onCancel={(event) => {
    if (deleting) event.preventDefault(); else onClose();
  }}>
    <header className="dialog-heading">
      <div><h2 id={headingId}>{mode === 'manifest' ? 'Manifest' : 'Delete graphic?'}</h2><p>{entry.label || entry.display_name} <span>v{entry.versionLabel}</span></p></div>
      <button className="icon-button" type="button" disabled={deleting} onClick={onClose} title="Close dialog" aria-label="Close dialog"><X size={18} /></button>
    </header>
    <div className="dialog-content">
      {error && <p className="error-message" role="alert">{error}</p>}
      {mode === 'manifest' ? <>
        {loading && <p role="status">Loading manifest...</p>}
        {!loading && !error && <pre className="manifest-json">{JSON.stringify(manifest, null, 2)}</pre>}
      </> : <>
        <p>Remove this entry from My Graphics?</p>
        <div className="dialog-actions">
          <button className="text-button" type="button" disabled={deleting} onClick={onClose}>Cancel</button>
          <button className="danger-button" type="button" disabled={deleting} onClick={remove}><Trash2 size={16} />{deleting ? 'Deleting...' : 'Delete'}</button>
        </div>
      </>}
    </div>
  </dialog>;
}

function GraphicEntry({ entry, busy, Preview, onSave, onProperties, onAction, onDelete, onManifest }) {
  const [label, setLabel] = useState(entry.label ?? '');
  const [error, setError] = useState('');
  useEffect(() => setLabel(entry.label ?? ''), [entry.label]);
  const actionable = entry.enabled && !entry.packageDisabled && canControlGraphic(entry.control);
  const unavailableReason = entry.packageDisabled ? 'Package disabled' : !entry.enabled ? 'Enable this entry to play or update' : 'Renderer controls are not available';
  async function save(changes) {
    setError('');
    try { await onSave(entry.entryId, changes); }
    catch (failure) { setError(failure.message); }
  }
  return (
    <li className={`graphic-entry${entry.enabled ? '' : ' is-disabled'}`}>
      <div className="entry-preview"><Preview item={entry} /></div>
      <div className="entry-details">
        <h3>{entry.display_name}</h3>
        <p className="entry-meta">v{entry.versionLabel} <span>{entry.origin === 'upload' ? 'Upload' : 'Catalog'}</span> <span>Entry {entry.entryId}</span></p>
        <form className="entry-label" onSubmit={(event) => { event.preventDefault(); save({ label: label.trim() || null }); }}>
          <label htmlFor={`label-${entry.entryId}`}>Label</label>
          <input id={`label-${entry.entryId}`} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} placeholder={entry.display_name} disabled={busy} />
          <button className="icon-button" type="submit" disabled={busy || label === (entry.label ?? '')} title="Save label" aria-label="Save label"><Save size={16} /></button>
        </form>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
      <div className="entry-controls">
        <label className="enabled-control"><input type="checkbox" checked={entry.enabled} disabled={busy || (entry.packageDisabled && !entry.enabled)} onChange={(event) => save({ enabled: event.target.checked })} /><span>{entry.enabled ? 'Enabled' : 'Disabled'}</span></label>
        <div className="entry-actions">
          <button className="icon-button" type="button" onClick={() => onProperties(entry)} disabled={busy} title="Edit properties" aria-label="Edit properties"><SlidersHorizontal size={18} /></button>
          <button className="icon-button play-button" type="button" onClick={() => onAction(entry, 'playAction')} disabled={busy || !actionable} title={actionable ? 'Play' : unavailableReason} aria-label="Play"><Play size={18} /></button>
          <button className="icon-button" type="button" onClick={() => onAction(entry, 'stopAction')} disabled={busy || entry.packageDisabled || !canControlGraphic(entry.control)} title={canControlGraphic(entry.control) ? 'Stop' : 'Renderer controls are not available'} aria-label="Stop"><Square size={16} /></button>
          <button className="icon-button" type="button" onClick={() => onAction(entry, 'updateAction')} disabled={busy || !actionable} title={actionable ? 'Update with saved properties' : unavailableReason} aria-label="Update"><RefreshCw size={18} /></button>
          <EntryMenu entry={entry} busy={busy} onDelete={onDelete} onManifest={onManifest} />
        </div>
        <span className="entry-availability">{entry.packageDisabled ? 'Package unavailable' : canControlGraphic(entry.control) ? 'Renderer ready' : 'Renderer unavailable'}</span>
      </div>
    </li>
  );
}

export default function MyGraphicsView({ account, entries, loading, error, pending, Preview, onRetry, onSave, onAction, onDelete, onManifest }) {
  const [editing, setEditing] = useState(null);
  const [entryDialog, setEntryDialog] = useState(null);
  return (
    <section className="my-graphics-section" aria-labelledby="my-graphics-heading">
      <div className="working-set-heading"><h1 id="my-graphics-heading">My Graphics</h1>{account && <span>{entries.length} entries / {entries.filter((entry) => entry.enabled).length} enabled</span>}</div>
      {!account ? <div className="empty-state"><strong>Sign in to view My Graphics.</strong><a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a></div> : <>
        {loading && <p role="status" className="status">Loading My Graphics...</p>}
        {error && <div className="load-error" role="alert"><p>{error}</p><button className="text-button" type="button" onClick={onRetry}><RefreshCw size={16} />Retry</button></div>}
        {!loading && !error && entries.length === 0 && <div className="empty-state"><strong>No graphics added yet.</strong><a className="login-link" href="#catalog">Browse catalog</a></div>}
        {!loading && !error && <ul className="graphics-list">{entries.map((entry) => <GraphicEntry key={entry.entryId} entry={entry} busy={pending.has(entry.entryId)} Preview={Preview} onSave={onSave} onProperties={setEditing} onAction={onAction}
          onDelete={(item) => setEntryDialog({ entry: item, mode: 'delete' })} onManifest={(item) => setEntryDialog({ entry: item, mode: 'manifest' })} />)}</ul>}
      </>}
      {editing && <PropertiesDialog key={editing.entryId} entry={editing} onSave={onSave} onClose={() => setEditing(null)} />}
      {entryDialog && <EntryDialog key={`${entryDialog.entry.entryId}-${entryDialog.mode}`} {...entryDialog} onDelete={onDelete} onManifest={onManifest} onClose={() => setEntryDialog(null)} />}
    </section>
  );
}