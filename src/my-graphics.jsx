import React, { useEffect, useId, useRef, useState } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { getTemplate, getUiOptions } from '@rjsf/utils';
import { ArrowDown, ArrowUp, FileJson, Info, GripVertical, MoreHorizontal, Pencil, Play, RefreshCw, Save, SlidersHorizontal, Square, Trash2, X } from 'lucide-react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { canControlGraphic } from './api.js';

class PropertyFormBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error ? <p role="alert">This graphic has an unsupported property schema.</p> : this.props.children;
  }
}

const tooltip = (description) => typeof description === 'string' && description.trim() ? description : undefined;

// Descriptions are shown as tooltips; the text stays in the DOM for the inputs' aria-describedby.
function PropertyDescription({ id, description }) {
  return description ? <span id={id} className="visually-hidden">{description}</span> : null;
}

function PropertyField(props) {
  const { id, label, children, errors, help, description, rawDescription, hidden, required, displayLabel, registry, uiSchema, schema, formData } = props;
  if (hidden) return <div className="hidden">{children}</div>;
  if (schema?.v_spx?.ftype === 'instruction') {
    const text = formData ?? schema.default;
    return text ? <p className="property-instruction" id={id}>{String(text)}</p> : null;
  }
  const uiOptions = getUiOptions(uiSchema);
  const WrapIfAdditionalTemplate = getTemplate('WrapIfAdditionalTemplate', registry, uiOptions);
  const title = tooltip(rawDescription);
  return <WrapIfAdditionalTemplate {...props}>
    {displayLabel && uiOptions.widget !== 'checkbox' ? <div className="property-row" title={title}>
      <label className="control-label" htmlFor={id}>{label}{required && <span className="required">*</span>}{title && <Info size={13} aria-hidden="true" />}</label>
      <div className="property-input">{children}{errors}{help}</div>
    </div> : <div title={id === 'root' ? undefined : title}>{children}{errors}{help}</div>}
    {description}
  </WrapIfAdditionalTemplate>;
}

const propertyTemplates = { FieldTemplate: PropertyField, DescriptionFieldTemplate: PropertyDescription };

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
      <div className="dialog-content properties-form">
        {error && <p role="alert" className="error-message">{error}</p>}
        <PropertyFormBoundary>
          <Form schema={entry.schema} validator={validator} templates={propertyTemplates} formData={data} onChange={(event) => setData(event.formData)}
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

export function ActionMenu({ label, busy, items }) {
  const [open, setOpen] = useState(false);
  const container = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    const closeOutside = (event) => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('focusin', closeOutside); };
  }, [open]);
  function choose(callback) {
    setOpen(false);
    trigger.current?.focus();
    callback();
  }
  return <div className="entry-menu" ref={container} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(menu.current.querySelectorAll('[role="menuitem"]'));
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}>
    <button ref={trigger} className="icon-button" type="button" disabled={busy} onClick={() => setOpen(!open)}
      aria-label={label} title="More options" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}><MoreHorizontal size={19} /></button>
    {open && <div ref={menu} id={menuId} className="entry-menu-popup" role="menu" aria-label="Graphic options">
      {items.filter(Boolean).map(({ key, label: itemLabel, icon: Icon, href, onSelect, danger }) => href
        ? <a key={key} role="menuitem" href={href} onClick={() => setOpen(false)}><Icon size={16} />{itemLabel}</a>
        : <button key={key} className={danger ? 'danger-menu-item' : undefined} type="button" role="menuitem" onClick={() => choose(onSelect)}><Icon size={16} />{itemLabel}</button>)}
    </div>}
  </div>;
}

function EntryMenu({ entry, busy, onDelete, onManifest }) {
  return <ActionMenu label={`More options for ${entry.label || entry.display_name}`} busy={busy} items={[
    entry.origin === 'catalog' && !entry.packageDisabled && { key: 'details', label: 'Show details', icon: Info, href: `#graphic/${encodeURIComponent(entry.versionId)}` },
    { key: 'manifest', label: 'Show manifest', icon: FileJson, onSelect: () => onManifest(entry) },
    { key: 'delete', label: 'Delete', icon: Trash2, onSelect: () => onDelete(entry), danger: true }
  ]} />;
}

export function EntryDialog({ entry, mode, onDelete, onManifest, onClose }) {
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
  return <dialog ref={dialog} className={`properties-dialog${mode === 'manifest' ? ' manifest-dialog' : ''}`} aria-labelledby={headingId} onCancel={(event) => {
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

function GraphicEntry({ entry, busy, orderDisabled, first, last, onMove, Preview, onSave, onProperties, onAction, onDelete, onManifest }) {
  const [label, setLabel] = useState(entry.label ?? entry.display_name);
  const [editingLabel, setEditingLabel] = useState(false);
  const [savingLabel, setSavingLabel] = useState(false);
  const labelInput = useRef(null);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.entryId, disabled: orderDisabled || editingLabel || savingLabel
  });
  const [error, setError] = useState('');
  useEffect(() => setLabel(entry.label ?? entry.display_name), [entry.label, entry.display_name]);
  useEffect(() => {
    if (editingLabel) { labelInput.current?.focus(); labelInput.current?.select(); }
  }, [editingLabel]);
  const actionable = entry.enabled && !entry.packageDisabled && canControlGraphic(entry.control);
  const unavailableReason = entry.packageDisabled ? 'Package disabled' : !entry.enabled ? 'Enable this entry to play or update' : 'Renderer controls are not available';
  async function save(changes) {
    setError('');
    try { await onSave(entry.entryId, changes); }
    catch (failure) { setError(failure.message); }
  }
  function cancelLabel() {
    setLabel(entry.label ?? entry.display_name);
    setEditingLabel(false);
    setError('');
  }
  async function saveLabel(event) {
    event.preventDefault();
    if (savingLabel || busy) return;
    setSavingLabel(true);
    setError('');
    const value = label.trim();
    try {
      await onSave(entry.entryId, { label: value && value !== entry.display_name ? value : null });
      setEditingLabel(false);
    } catch (failure) { setError(failure.message); }
    finally { setSavingLabel(false); }
  }
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`graphic-entry${entry.enabled ? '' : ' is-disabled'}${isDragging ? ' is-dragging' : ''}`}>
      <div className="entry-order-controls">
        <button ref={setActivatorNodeRef} {...attributes} {...listeners} className="icon-button drag-handle" type="button"
          disabled={orderDisabled || editingLabel || savingLabel} title="Drag to reorder" aria-label={`Drag ${entry.label || entry.display_name} to reorder`}><GripVertical size={18} /></button>
        <button className="icon-button" type="button" disabled={orderDisabled || first || editingLabel || savingLabel} onClick={() => onMove(-1)} title="Move up" aria-label={`Move ${entry.label || entry.display_name} up`}><ArrowUp size={15} /></button>
        <button className="icon-button" type="button" disabled={orderDisabled || last || editingLabel || savingLabel} onClick={() => onMove(1)} title="Move down" aria-label={`Move ${entry.label || entry.display_name} down`}><ArrowDown size={15} /></button>
      </div>
      <div className="entry-preview"><Preview item={entry} /></div>
      <div className="entry-details">
        {editingLabel ? <form className="entry-label" onSubmit={saveLabel} onKeyDown={(event) => {
          if (event.key === 'Escape' && !savingLabel && !busy) { event.preventDefault(); cancelLabel(); }
        }}>
          <input ref={labelInput} id={`label-${entry.entryId}`} aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} placeholder={entry.display_name} disabled={busy || savingLabel} />
          <button className="icon-button" type="submit" disabled={busy || savingLabel} title="Save label" aria-label="Save label"><Save size={16} /></button>
          <button className="icon-button" type="button" onClick={cancelLabel} disabled={busy || savingLabel} title="Cancel label edit" aria-label="Cancel label edit"><X size={16} /></button>
        </form> : <div className="entry-title">
          <h3>{entry.label || entry.display_name}</h3>
          <button className="icon-button edit-label-button" type="button" onClick={() => { setError(''); setEditingLabel(true); }} disabled={busy} title="Edit label" aria-label={`Edit label for ${entry.label || entry.display_name}`}><Pencil size={15} /></button>
        </div>}
        {entry.label && entry.label !== entry.display_name && <p className="entry-meta entry-original-name">{entry.display_name}</p>}
        <p className="entry-meta">v{entry.versionLabel} <span>{entry.origin === 'upload' ? 'Upload' : 'Catalog'}</span> <span>Entry {entry.entryId}</span></p>
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

export default function MyGraphicsView({ account, entries, loading, error, pending, Preview, onRetry, onSave, onAction, onDelete, onManifest, onReorder }) {
  const [editing, setEditing] = useState(null);
  const [entryDialog, setEntryDialog] = useState(null);
  const [ordering, setOrdering] = useState(false);
  const [orderError, setOrderError] = useState('');
  const reorderInFlight = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const orderDisabled = ordering || pending.size > 0 || entries.length < 2;
  async function moveEntry(from, to) {
    if (orderDisabled || reorderInFlight.current || from === to || from < 0 || to < 0 || to >= entries.length) return;
    reorderInFlight.current = true;
    setOrdering(true);
    setOrderError('');
    try { await onReorder(arrayMove(entries, from, to).map((entry) => entry.entryId)); }
    catch (failure) { setOrderError(failure.message); }
    finally { reorderInFlight.current = false; setOrdering(false); }
  }
  return (
    <section className="my-graphics-section" aria-labelledby="my-graphics-heading">
      <div className="working-set-heading"><h1 id="my-graphics-heading">My Graphics</h1>{account && <span>{entries.length} entries / {entries.filter((entry) => entry.enabled).length} enabled</span>}</div>
      {!account ? <div className="empty-state"><strong>Sign in to view My Graphics.</strong><a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a></div> : <>
        {loading && <p role="status" className="status">Loading My Graphics...</p>}
        {ordering && <p role="status" className="status">Saving order...</p>}
        {orderError && <div className="load-error" role="alert"><p>{orderError}</p><button className="text-button" type="button" onClick={() => { setOrderError(''); onRetry(); }}><RefreshCw size={16} />Refresh list</button></div>}
        {error && <div className="load-error" role="alert"><p>{error}</p><button className="text-button" type="button" onClick={onRetry}><RefreshCw size={16} />Retry</button></div>}
        {!loading && !error && entries.length === 0 && <div className="empty-state"><strong>No graphics added yet.</strong><a className="login-link" href="#catalog">Browse catalog</a></div>}
        {!loading && !error && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
          if (over) void moveEntry(entries.findIndex((entry) => entry.entryId === active.id), entries.findIndex((entry) => entry.entryId === over.id));
        }}>
          <SortableContext items={entries.map((entry) => entry.entryId)} strategy={verticalListSortingStrategy}>
            <ul className="graphics-list">{entries.map((entry, index) => <GraphicEntry key={entry.entryId} entry={entry} busy={ordering || pending.has(entry.entryId)}
              orderDisabled={orderDisabled} first={index === 0} last={index === entries.length - 1} onMove={(direction) => moveEntry(index, index + direction)} Preview={Preview} onSave={onSave} onProperties={setEditing} onAction={onAction}
              onDelete={(item) => setEntryDialog({ entry: item, mode: 'delete' })} onManifest={(item) => setEntryDialog({ entry: item, mode: 'manifest' })} />)}</ul>
          </SortableContext>
        </DndContext>}
      </>}
      {editing && <PropertiesDialog key={editing.entryId} entry={editing} onSave={onSave} onClose={() => setEditing(null)} />}
      {entryDialog && <EntryDialog key={`${entryDialog.entry.entryId}-${entryDialog.mode}`} {...entryDialog} onDelete={onDelete} onManifest={onManifest} onClose={() => setEntryDialog(null)} />}
    </section>
  );
}