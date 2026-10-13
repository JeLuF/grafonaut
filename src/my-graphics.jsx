import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { getTemplate, getUiOptions } from '@rjsf/utils';
import { ArrowDown, ArrowUp, FileJson, Info, GripVertical, MoreHorizontal, Pencil, Play, RefreshCw, Save, SlidersHorizontal, Square, Trash2, X, Zap } from 'lucide-react';
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

// Larger, styled replacement for the native title tooltip. Fixed positioning keeps it from being clipped by the scrolling dialog.
function TooltipRow({ text, className, children }) {
  const [position, setPosition] = useState(null);
  const row = useRef(null);
  useEffect(() => {
    if (!position) return;
    const hide = () => setPosition(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [position]);
  function show() {
    if (!text || !row.current) return;
    const rect = row.current.getBoundingClientRect();
    setPosition(rect.top > 140 ? { left: rect.left, top: rect.top - 8, above: true } : { left: rect.left, top: rect.bottom + 8, above: false });
  }
  function leave(event) {
    if (!row.current?.contains(event.relatedTarget)) setPosition(null);
  }
  return <div ref={row} className={className} onMouseEnter={show} onMouseLeave={() => { if (!row.current?.contains(document.activeElement)) setPosition(null); }}
    onFocus={show} onBlur={leave} data-has-tooltip={text ? '' : undefined}>
    {children}
    {text && position && <div className={`property-tooltip${position.above ? ' is-above' : ''}`} style={{ left: position.left, top: position.top }} aria-hidden="true">{text}</div>}
  </div>;
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
    {displayLabel && uiOptions.widget !== 'checkbox' ? <TooltipRow className="property-row" text={title}>
      <label className="control-label" htmlFor={id}>{label}{required && <span className="required">*</span>}{title && <Info size={13} aria-hidden="true" />}</label>
      <div className="property-input">{children}{errors}{help}</div>
    </TooltipRow> : <TooltipRow text={id === 'root' ? undefined : title}>{children}{errors}{help}</TooltipRow>}
    {description}
  </WrapIfAdditionalTemplate>;
}

const propertyTemplates = { FieldTemplate: PropertyField, DescriptionFieldTemplate: PropertyDescription };

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Maps GDD/SPX display hints that RJSF does not understand onto JSON Schema: `label` becomes the field title,
// and `gddOptions.labels` names the values of an enum.
export function displaySchema(schema) {
  if (Array.isArray(schema)) return schema.map(displaySchema);
  if (!isObject(schema)) return schema;
  const result = { ...schema };
  if (isObject(schema.properties)) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, displaySchema(value)]));
  if (schema.items) result.items = displaySchema(schema.items);
  if (typeof schema.title !== 'string' && typeof schema.label === 'string' && schema.label.trim()) result.title = schema.label;
  const labels = schema.gddOptions?.labels;
  if (Array.isArray(schema.enum) && isObject(labels) && !schema.oneOf) {
    result.oneOf = schema.enum.map((value) => ({ const: value, title: typeof labels[String(value)] === 'string' ? labels[String(value)] : String(value) }));
    delete result.enum;
  }
  return result;
}

export function PropertiesDialog({ entry, onSave, onClose }) {
  const dialog = useRef(null);
  const headingId = useId();
  const [data, setData] = useState(entry.schemaData ?? {});
  const schema = useMemo(() => displaySchema(entry.schema), [entry.schema]);
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
          <Form schema={schema} validator={validator} templates={propertyTemplates} formData={data} onChange={(event) => setData(event.formData)}
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

export function ActionMenu({ label, busy, items, icon: TriggerIcon = MoreHorizontal, title = 'More options', menuLabel = 'Graphic options' }) {
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
      aria-label={label} title={title} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}><TriggerIcon size={19} /></button>
    {open && <div ref={menu} id={menuId} className="entry-menu-popup" role="menu" aria-label={menuLabel}>
      {items.filter(Boolean).map(({ key, label: itemLabel, icon: Icon, href, onSelect, danger, hint }) => href
        ? <a key={key} role="menuitem" href={href} onClick={() => setOpen(false)}><Icon size={16} />{itemLabel}</a>
        : <button key={key} className={danger ? 'danger-menu-item' : undefined} type="button" role="menuitem" title={hint || undefined}
          onClick={() => choose(onSelect)}><Icon size={16} />{itemLabel}</button>)}
    </div>}
  </div>;
}

function EntryMenu({ entry, busy, onDelete, onManifest }) {
  return <ActionMenu label={`More options for ${entry.label || entry.display_name}`} busy={busy} items={[
    !entry.packageDisabled && { key: 'details', label: 'Show details', icon: Info, href: `#graphic/${encodeURIComponent(entry.versionId)}` },
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
  return <dialog ref={dialog} className={`properties-dialog ${mode === 'manifest' ? 'manifest-dialog' : 'confirm-dialog'}`} aria-labelledby={headingId} onCancel={(event) => {
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
        <p>Remove this graphic from the rundown?</p>
        <div className="dialog-actions">
          <button className="text-button" type="button" disabled={deleting} onClick={onClose}>Cancel</button>
          <button className="danger-button" type="button" disabled={deleting} onClick={remove}><Trash2 size={16} />{deleting ? 'Deleting...' : 'Delete'}</button>
        </div>
      </>}
    </div>
  </dialog>;
}

// Actions with a payload schema ask for the payload first; actions without one run directly.
const needsPayload = (action) => Boolean(action.schema && action.schema.type === 'object' && Object.keys(action.schema.properties ?? {}).length);

export function CustomActionDialog({ entry, action, onRun, onClose }) {
  const dialog = useRef(null);
  const headingId = useId();
  const schema = useMemo(() => displaySchema(action.schema), [action.schema]);
  const [data, setData] = useState({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  async function run({ formData }) {
    setRunning(true);
    setError('');
    try { await onRun(entry, action, formData ?? {}); onClose(); }
    catch (failure) { setError(failure.message); }
    finally { setRunning(false); }
  }
  return (
    <dialog ref={dialog} className="properties-dialog confirm-dialog custom-action-dialog" aria-labelledby={headingId} onCancel={(event) => {
      if (running) event.preventDefault(); else onClose();
    }}>
      <header className="dialog-heading">
        <div><h2 id={headingId}>{action.name}</h2><p>{entry.label || entry.display_name}</p></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={running} aria-label="Close custom action" title="Close"><X size={18} /></button>
      </header>
      <div className="dialog-content properties-form">
        {action.description && <p className="property-instruction">{action.description}</p>}
        {error && <p role="alert" className="error-message">{error}</p>}
        <PropertyFormBoundary>
          <Form schema={schema} validator={validator} templates={propertyTemplates} formData={data} onChange={(event) => setData(event.formData)}
            onSubmit={run} disabled={running} noHtml5Validate>
            <div className="dialog-actions">
              <button className="text-button" type="button" onClick={onClose} disabled={running}>Cancel</button>
              <button className="primary-button" type="submit" disabled={running}><Zap size={16} />{running ? 'Running...' : 'Run action'}</button>
            </div>
          </Form>
        </PropertyFormBoundary>
      </div>
    </dialog>
  );
}

function GraphicEntry({ entry, busy, orderDisabled, first, last, onMove, Preview, connections, onSave, onProperties, onAction, onCustomAction, onDelete, onManifest }) {
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
          {entry.customActions?.length > 0 && <ActionMenu label={`Custom actions for ${entry.label || entry.display_name}`} busy={busy || !actionable}
            icon={Zap} title={actionable ? 'Custom actions' : unavailableReason} menuLabel="Custom actions"
            items={entry.customActions.map((action) => ({ key: action.id, label: action.name, icon: Zap, hint: action.description, onSelect: () => onCustomAction(entry, action) }))} />}
          <EntryMenu entry={entry} busy={busy} onDelete={onDelete} onManifest={onManifest} />
        </div>
        <span className={`entry-availability${entry.live?.playing ? ' is-on-air' : ''}`}>{entry.packageDisabled ? 'Package unavailable'
          : !canControlGraphic(entry.control) ? 'Renderer unavailable'
            : entry.live?.playing ? 'On air' : entry.live?.ended ? 'Played' : entry.live ? 'Loaded' : connections === 0 ? 'No renderer connected' : 'Ready'}</span>
      </div>
    </li>
  );
}

export default function MyGraphicsView({ account, rundownName, entries, loading, error, pending, Preview, rendererPreview, rendererStatus, onRetry, onSave, onAction, onCustomAction = async () => {}, onDelete, onManifest, onReorder }) {
  const [editing, setEditing] = useState(null);
  const [customAction, setCustomAction] = useState(null);
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
      <p className="eyebrow rundown-eyebrow">RUNDOWN</p>
      <div className="working-set-heading"><h1 id="my-graphics-heading">{account && rundownName ? rundownName : 'Rundown'}</h1>{account && <span>{entries.length} entries / {entries.filter((entry) => entry.enabled).length} enabled{rendererStatus && <>
        {' · '}<span className={rendererStatus.connections ? 'renderer-connected' : 'renderer-disconnected'}>{rendererStatus.connections
          ? `${rendererStatus.connections} renderer${rendererStatus.connections === 1 ? '' : 's'} connected` : 'No renderer connected'}</span></>}</span>}</div>
      {!account ? <div className="empty-state"><strong>Sign in to prepare your rundowns.</strong><a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a></div> : <div className="my-graphics-layout">
        {rendererPreview}
        <div className="my-graphics-entries">
        {loading && <p role="status" className="status">Loading rundown...</p>}
        {ordering && <p role="status" className="status">Saving order...</p>}
        {orderError && <div className="load-error" role="alert"><p>{orderError}</p><button className="text-button" type="button" onClick={() => { setOrderError(''); onRetry(); }}><RefreshCw size={16} />Refresh list</button></div>}
        {error && <div className="load-error" role="alert"><p>{error}</p><button className="text-button" type="button" onClick={onRetry}><RefreshCw size={16} />Retry</button></div>}
        {!loading && !error && entries.length === 0 && <div className="empty-state"><strong>No graphics added yet.</strong><a className="login-link" href="#catalog">Browse catalog</a></div>}
        {!loading && !error && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
          if (over) void moveEntry(entries.findIndex((entry) => entry.entryId === active.id), entries.findIndex((entry) => entry.entryId === over.id));
        }}>
          <SortableContext items={entries.map((entry) => entry.entryId)} strategy={verticalListSortingStrategy}>
            <ul className="graphics-list">{entries.map((entry, index) => <GraphicEntry key={entry.entryId} entry={entry} busy={ordering || pending.has(entry.entryId)}
              orderDisabled={orderDisabled} first={index === 0} last={index === entries.length - 1} onMove={(direction) => moveEntry(index, index + direction)} Preview={Preview} connections={rendererStatus?.connections} onSave={onSave} onProperties={setEditing} onAction={onAction}
              onCustomAction={(item, action) => needsPayload(action) ? setCustomAction({ entry: item, action }) : onCustomAction(item, action, {}).catch(() => {})}
              onDelete={(item) => setEntryDialog({ entry: item, mode: 'delete' })} onManifest={(item) => setEntryDialog({ entry: item, mode: 'manifest' })} />)}</ul>
          </SortableContext>
        </DndContext>}
        </div>
      </div>}
      {editing && <PropertiesDialog key={editing.entryId} entry={editing} onSave={onSave} onClose={() => setEditing(null)} />}
      {customAction && <CustomActionDialog key={`${customAction.entry.entryId}-${customAction.action.id}`} {...customAction} onRun={onCustomAction} onClose={() => setCustomAction(null)} />}
      {entryDialog && <EntryDialog key={`${entryDialog.entry.entryId}-${entryDialog.mode}`} {...entryDialog} onDelete={onDelete} onManifest={onManifest} onClose={() => setEntryDialog(null)} />}
    </section>
  );
}