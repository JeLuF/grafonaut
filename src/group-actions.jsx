import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { ArrowDown, ArrowUp, Pencil, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { displaySchema, PropertyFormBoundary, propertyTemplates } from './my-graphics.jsx';

const stepTypes = [['play', 'Play'], ['stop', 'Stop'], ['update', 'Update'], ['custom', 'Custom action'], ['sleep', 'Sleep']];
const entryName = (entry) => entry.label || entry.display_name;
const needsPayload = (action) => Boolean(action?.schema && action.schema.type === 'object' && Object.keys(action.schema.properties ?? {}).length);

function newStep(entries) {
  return { type: 'play', entryId: entries[0]?.entryId ?? '' };
}

// Changing the type or the graphic keeps what still applies and fills in sensible defaults.
function changeStep(step, changes, entries) {
  const next = { ...step, ...changes };
  if (next.type === 'sleep') return { type: 'sleep', ms: Number.isInteger(step.ms) ? step.ms : 1000 };
  const entryId = next.entryId ?? entries[0]?.entryId ?? '';
  if (next.type !== 'custom') return { type: next.type, entryId };
  const actions = entries.find((entry) => entry.entryId === entryId)?.customActions ?? [];
  const actionId = actions.some((action) => action.id === next.actionId) ? next.actionId : actions[0]?.id ?? '';
  return { type: 'custom', entryId, actionId, payload: actionId === step.actionId && step.payload ? step.payload : {} };
}

function PayloadForm({ action, payload, onChange }) {
  const schema = useMemo(() => displaySchema(action.schema), [action.schema]);
  return <PropertyFormBoundary>
    <Form tagName="div" schema={schema} validator={validator} templates={propertyTemplates} formData={payload}
      onChange={(event) => onChange(event.formData ?? {})} noHtml5Validate><></></Form>
  </PropertyFormBoundary>;
}

function StepEditor({ step, index, count, entries, onChange, onMove, onRemove }) {
  const id = useId();
  const entry = entries.find((candidate) => candidate.entryId === step.entryId);
  const actions = entry?.customActions ?? [];
  const action = actions.find((candidate) => candidate.id === step.actionId);
  return <li className="group-step">
    <div className="group-step-row">
      <span className="group-step-number">{index + 1}</span>
      <select aria-label={`Step ${index + 1} type`} value={step.type} onChange={(event) => onChange(changeStep(step, { type: event.target.value }, entries))}>
        {stepTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {step.type === 'sleep'
        ? <label className="group-step-sleep" htmlFor={`${id}-seconds`}>
          <input id={`${id}-seconds`} type="number" min="0" max="600" step="0.1" aria-label={`Step ${index + 1} seconds`}
            value={step.ms / 1000} onChange={(event) => onChange({ type: 'sleep', ms: Math.max(0, Math.round(Number(event.target.value) * 1000) || 0) })} />
          seconds</label>
        : <select aria-label={`Step ${index + 1} graphic`} value={entry ? step.entryId : ''}
          onChange={(event) => onChange(changeStep(step, { entryId: event.target.value }, entries))}>
          {!entry && <option value="">{step.entryId ? 'Missing graphic' : 'Choose a graphic'}</option>}
          {entries.map((candidate) => <option key={candidate.entryId} value={candidate.entryId}>{entryName(candidate)}</option>)}
        </select>}
      {step.type === 'custom' && (actions.length
        ? <select aria-label={`Step ${index + 1} custom action`} value={step.actionId} onChange={(event) => onChange(changeStep(step, { actionId: event.target.value }, entries))}>
          {actions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        : <span className="group-step-note">This graphic has no custom actions</span>)}
      <div className="group-step-tools">
        <button className="icon-button" type="button" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move step ${index + 1} up`} title="Move up"><ArrowUp size={14} /></button>
        <button className="icon-button" type="button" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move step ${index + 1} down`} title="Move down"><ArrowDown size={14} /></button>
        <button className="icon-button" type="button" onClick={onRemove} aria-label={`Remove step ${index + 1}`} title="Remove step"><Trash2 size={14} /></button>
      </div>
    </div>
    {step.type === 'custom' && needsPayload(action) && <div className="group-step-payload">
      <PayloadForm action={action} payload={step.payload ?? {}} onChange={(payload) => onChange({ ...step, payload })} />
    </div>}
  </li>;
}

export function GroupActionEditor({ group, entries, onSave, onDelete, onClose }) {
  const dialog = useRef(null);
  const headingId = useId();
  const [name, setName] = useState(group?.name ?? '');
  const [steps, setSteps] = useState(group?.steps ?? [newStep(entries)]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  const update = (index, step) => setSteps((current) => current.map((item, position) => position === index ? step : item));
  function move(index, direction) {
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + direction]] = [next[index + direction], next[index]];
      return next;
    });
  }
  async function run(work) {
    setSaving(true);
    setError(null);
    try { await work(); onClose(); }
    catch (failure) { setError({ message: failure.message, details: failure.payload?.details ?? [] }); }
    finally { setSaving(false); }
  }
  return (
    <dialog ref={dialog} className="properties-dialog group-action-dialog" aria-labelledby={headingId} onCancel={(event) => {
      if (saving) event.preventDefault(); else onClose();
    }}>
      <header className="dialog-heading">
        <div><h2 id={headingId}>{group ? 'Edit group action' : 'New group action'}</h2><p>Steps start together; a sleep step waits before the next ones.</p></div>
        <button className="icon-button" type="button" onClick={onClose} disabled={saving} aria-label="Close group action" title="Close"><X size={18} /></button>
      </header>
      <form className="dialog-content properties-form" onSubmit={(event) => { event.preventDefault(); void run(() => onSave(group, { name: name.trim(), steps })); }}>
        <div className="property-row">
          <label className="control-label" htmlFor={`${headingId}-name`}>Name</label>
          <div className="property-input"><input id={`${headingId}-name`} value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></div>
        </div>
        <h3 className="group-steps-heading">Steps</h3>
        {steps.length === 0 && <p className="status">No steps yet.</p>}
        <ol className="group-steps">
          {steps.map((step, index) => <StepEditor key={index} step={step} index={index} count={steps.length} entries={entries}
            onChange={(next) => update(index, next)} onMove={(direction) => move(index, direction)}
            onRemove={() => setSteps((current) => current.filter((_, position) => position !== index))} />)}
        </ol>
        <button className="text-button" type="button" onClick={() => setSteps((current) => [...current, newStep(entries)])}><Plus size={16} />Add step</button>
        {error && <div className="error-message" role="alert"><p>{error.message}</p>{error.details.length > 0 && <ul>{error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}</div>}
        {confirmDelete && <div className="token-confirm" role="group" aria-label="Confirm group action deletion">
          <p>Delete the group action {group.name}? This cannot be undone.</p>
          <div className="renderer-actions">
            <button className="text-button" type="button" onClick={() => setConfirmDelete(false)} disabled={saving}>Cancel</button>
            <button className="danger-button" type="button" onClick={() => run(() => onDelete(group))} disabled={saving}>Delete</button>
          </div>
        </div>}
        <div className="dialog-actions">
          {group && !confirmDelete && <button className="text-button group-delete" type="button" onClick={() => setConfirmDelete(true)} disabled={saving}><Trash2 size={16} />Delete</button>}
          <button className="text-button" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary-button" type="submit" disabled={saving || !name.trim()}><Save size={16} />{saving ? 'Saving...' : 'Save group action'}</button>
        </div>
      </form>
    </dialog>
  );
}

// Group actions of the current rundown: a run button and a pencil per group, plus "New group action".
export function GroupActionsPanel({ groups, entries, error, running, disabled, onRun, onSave, onDelete }) {
  const [editing, setEditing] = useState(null);
  return <section className="group-actions" aria-labelledby="group-actions-heading">
    <div className="sidebar-heading-row">
      <h2 id="group-actions-heading" className="sidebar-heading">Group actions</h2>
      <button className="text-button" type="button" onClick={() => setEditing({ group: null })} disabled={!entries.length}
        title={entries.length ? 'New group action' : 'Add graphics to the rundown first'}><Plus size={15} />New group action</button>
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {groups.length === 0 ? <p className="status">Group actions trigger several actions with one click, e.g. stop one graphic and play the next.</p>
      : <ul className="group-action-list">
        {groups.map((group) => <li key={group.id} className="group-action">
          <button className="primary-button" type="button" onClick={() => onRun(group)} disabled={disabled || running.has(group.id)}
            aria-label={`Run ${group.name}`} title={`${group.steps.length} step${group.steps.length === 1 ? '' : 's'}`}>
            <Play size={15} />{running.has(group.id) ? 'Running...' : group.name}</button>
          <button className="icon-button" type="button" onClick={() => setEditing({ group })} aria-label={`Edit ${group.name}`} title="Edit"><Pencil size={15} /></button>
        </li>)}
      </ul>}
    {editing && <GroupActionEditor group={editing.group} entries={entries} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
  </section>;
}
