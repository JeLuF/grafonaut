import React, { useEffect, useId, useRef, useState } from 'react';
import * as fabric from 'fabric';
import SlideEditor from 'slide-editor/editor';
import { Save, X } from 'lucide-react';
import { requestJson } from './api.js';

// The slide editor (npm package slide-editor) in a dialog, in Grafonaut's colors. Loaded on demand by media.jsx: it
// brings Fabric.js along. `slide` is the JSON to edit (null for a new slide); onSave(name, slide) stores it.
const colors = { accent: '#7c5cff', onAccent: '#ffffff', background: '#0b1130', surface: '#10173a', border: '#27336b', text: '#eef1ff',
  muted: '#8890bd', hover: '#1a2453', stage: '#070b1e', selection: '#4cc9ff', guide: '#ff8a3d' };
export const slideSizes = [
  { label: 'Landscape 1920 × 1080', width: 1920, height: 1080 },
  { label: 'Portrait 1080 × 1920', width: 1080, height: 1920 },
  { label: 'Square 1080 × 1080', width: 1080, height: 1080 },
  { label: 'Landscape 1280 × 720', width: 1280, height: 720 }
];

export default function SlideEditorDialog({ title, initialName, slide, onSave, onClose }) {
  const dialog = useRef(null);
  const stage = useRef(null);
  const editor = useRef(null);
  const headingId = useId();
  const [name, setName] = useState(initialName);
  const [size, setSize] = useState(0);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element.showModal?.();
    // Fabric types into text through a hidden textarea, by default added to <body>. While the modal dialog is open,
    // everything outside it is inert, so the textarea would never get the keyboard: keep it inside the dialog.
    fabric.IText.ownDefaults.hiddenTextareaContainer = element;
    let active = true;
    (async () => {
      let fonts;
      try { fonts = (await requestJson('/api/slides/config')).fonts; } catch { /* the editor's own web-safe fonts */ }
      if (!active) return;
      const instance = SlideEditor.create(stage.current, { fabric, theme: 'dark', colors, width: slide?.width ?? 1920, height: slide?.height ?? 1080,
        ...(fonts ? { fonts } : {}) });
      editor.current = instance;
      if (slide) await instance.load(slide);
      if (!active) { instance.destroy(); return; }
      instance.on('change', () => setDirty(true));
      setReady(true);
    })().catch((failure) => { if (active) setError(`The editor could not be opened: ${failure.message}`); });
    return () => {
      active = false;
      editor.current?.destroy();
      editor.current = null;
      if (fabric.IText.ownDefaults.hiddenTextareaContainer === element) fabric.IText.ownDefaults.hiddenTextareaContainer = null;
      element.close?.();
    };
  }, [slide]);

  function close() {
    if (saving) return;
    if (dirty && !window.confirm('Discard the changes to this slide?')) return;
    onClose();
  }
  async function save(event) {
    event.preventDefault();
    if (!editor.current || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim() || 'Slide', editor.current.toJSON());
      onClose();
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialog} className="slide-editor-dialog" aria-labelledby={headingId}
    // Escape belongs to the editor (deselect, cancel a crop); the dialog closes with its buttons.
    onCancel={(event) => event.preventDefault()}>
    <form className="slide-editor-bar" onSubmit={save}>
      <h2 id={headingId}>{title}</h2>
      <input aria-label="Slide name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="Slide name" disabled={saving} />
      {!slide && <select aria-label="Slide size" value={size} disabled={!ready || saving} onChange={(event) => {
        const next = Number(event.target.value);
        setSize(next);
        editor.current?.setSize(slideSizes[next].width, slideSizes[next].height);
      }}>{slideSizes.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}</select>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="slide-editor-buttons">
        <button className="text-button" type="button" onClick={close} disabled={saving}><X size={15} />Cancel</button>
        <button className="primary-button" type="submit" disabled={!ready || saving}><Save size={15} />{saving ? 'Saving...' : 'Save slide'}</button>
      </div>
    </form>
    <div className="slide-editor-stage" ref={stage} />
  </dialog>;
}
