import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, File, FolderOpen, Image as ImageIcon, Pencil, RotateCcw, Trash2, Upload, Video, X } from 'lucide-react';
import { requestJson } from './api.js';

const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'apng'];
const videoExtensions = ['mp4', 'webm'];
const extensionOf = (name) => String(name ?? '').split(/[?#]/)[0].split('.').pop().toLowerCase();
const isImage = (extension) => imageExtensions.includes(extension);

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sendFile(url, method, file, maxBytes) {
  if (maxBytes && file.size > maxBytes) throw new Error(`${file.name} is larger than ${formatBytes(maxBytes)}`);
  try {
    return await requestJson(url, { method, headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  } catch (failure) {
    // A 413 without the app's JSON message comes from a proxy in front of the app (nginx allows 1 MB by default).
    if (failure.status === 413 && !failure.payload?.error) throw new Error(`${file.name} was refused by the web server's upload limit (e.g. nginx client_max_body_size)`);
    throw failure;
  }
}

// The account's media library (GET/POST /api/media, ...).
export function useMedia(account) {
  const [items, setItems] = useState([]);
  const [info, setInfo] = useState({ maxBytes: null, extensions: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!account) { setItems([]); return; }
    setLoading(true);
    try {
      const response = await requestJson('/api/media');
      setItems(response.items ?? []);
      setInfo({ maxBytes: response.maxBytes ?? null, extensions: response.extensions ?? [] });
      setError('');
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }, [account]);
  useEffect(() => { void reload(); }, [reload]);
  async function upload(file) {
    const { item } = await sendFile(`/api/media?name=${encodeURIComponent(file.name)}`, 'POST', file, info.maxBytes);
    setItems((current) => [item, ...current]);
    return item;
  }
  async function replace(item, file) {
    const { item: updated } = await sendFile(`/api/media/${item.id}/content?name=${encodeURIComponent(file.name)}`, 'PUT', file, info.maxBytes);
    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...updated, name: candidate.name, usage: candidate.usage } : candidate));
  }
  async function rename(item, name) {
    await requestJson(`/api/media/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, name } : candidate));
  }
  async function remove(item) {
    await requestJson(`/api/media/${item.id}`, { method: 'DELETE' });
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
  }
  return { items, ...info, error, loading, reload, upload, replace, rename, remove };
}

function MediaThumb({ item }) {
  const [failed, setFailed] = useState(false);
  if (item && isImage(item.extension) && !failed) return <img className="media-thumb" src={item.previewUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
  const Icon = item && videoExtensions.includes(item.extension) ? Video : item ? File : ImageIcon;
  return <span className="media-thumb media-thumb-icon"><Icon size={22} aria-hidden="true" /></span>;
}

// ---- Property dialog: file-path fields (e.g. gddType "file-path/image-path") ----

// Extensions a field accepts: gddOptions.extensions, otherwise images for image paths, otherwise anything.
export function acceptedExtensions(schema) {
  const listed = Array.isArray(schema?.gddOptions?.extensions) ? schema.gddOptions.extensions : null;
  if (listed?.length) return listed.map((extension) => String(extension).replace(/^\./, '').toLowerCase());
  return String(schema?.gddType ?? '').includes('image') ? imageExtensions : null;
}

// RJSF widget: choose the default (package) file, a file from the media library, or upload a new one.
export function MediaPathWidget({ id, value, onChange, schema, disabled, readonly, registry }) {
  const media = registry?.formContext?.media;
  const extensions = acceptedExtensions(schema);
  const matching = (media?.items ?? []).filter((item) => !extensions || extensions.includes(item.extension));
  const selected = (media?.items ?? []).find((item) => item.url === value);
  const fallback = typeof schema.default === 'string' ? schema.default : '';
  const isDefault = !value || value === fallback;
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const locked = disabled || readonly || busy;

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const item = await media.upload(file);
      onChange(item.url);
      setBrowsing(false);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return <div className="media-field">
    <div className="media-field-current">
      <MediaThumb item={selected} />
      <span className="media-field-label" id={`${id}-current`}>
        {isDefault ? <>Default{fallback && <small>{fallback.split('/').pop()}</small>}</>
          : selected ? <>{selected.name}<small>Media library</small></> : <>Custom file<small>{String(value)}</small></>}
      </span>
    </div>
    <div className="media-field-actions">
      <button className="text-button" type="button" disabled={locked || isDefault || !fallback} onClick={() => onChange(fallback)}><RotateCcw size={14} />Default</button>
      <button className="text-button" type="button" disabled={locked || !media} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}><FolderOpen size={14} />Media library</button>
      <button className="text-button" type="button" disabled={locked || !media} onClick={() => input.current?.click()}><Upload size={14} />{busy ? 'Uploading...' : 'Upload'}</button>
      <input ref={input} type="file" hidden accept={extensions ? extensions.map((extension) => `.${extension}`).join(',') : undefined}
        aria-label={`Upload a file for ${schema.title ?? id}`} onChange={(event) => upload(event.target.files?.[0])} />
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {browsing && <div className="media-picker" role="listbox" aria-label="Media library">
      {matching.length === 0 ? <p className="status">No {extensions ? extensions.map((extension) => `.${extension}`).join(', ') : ''} files in the media library yet.</p>
        : matching.map((item) => <button key={item.id} type="button" role="option" aria-selected={item.url === value}
          className={`media-pick${item.url === value ? ' is-selected' : ''}`} onClick={() => { onChange(item.url); setBrowsing(false); }}>
          <MediaThumb item={item} /><span>{item.name}</span>
        </button>)}
    </div>}
  </div>;
}

// ---- Media catalog page ----

function MediaCard({ item, media, onCopied }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const replaceInput = useRef(null);
  async function run(work) {
    setBusy(true);
    setError('');
    try { await work(); return true; } catch (failure) { setError(failure.message); return false; } finally { setBusy(false); }
  }
  return <li className="media-card">
    <MediaThumb item={item} />
    <div className="media-card-body">
      {renaming ? <form className="rundown-form-row" onSubmit={async (event) => {
        event.preventDefault();
        if (await run(() => media.rename(item, name.trim()))) setRenaming(false);
      }}>
        <input aria-label="File name" value={name} maxLength={255} onChange={(event) => setName(event.target.value)} disabled={busy} />
        <button className="icon-button" type="submit" disabled={busy || !name.trim()} aria-label="Save name" title="Save name"><Check size={14} /></button>
        <button className="icon-button" type="button" disabled={busy} onClick={() => { setName(item.name); setRenaming(false); }} aria-label="Cancel" title="Cancel"><X size={14} /></button>
      </form> : <h3 title={item.name}>{item.name}</h3>}
      <p className="media-meta">.{item.extension} · {formatBytes(item.size)} · {item.usage ? `used by ${item.usage} entr${item.usage === 1 ? 'y' : 'ies'}` : 'not used'}</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      {confirming ? <div className="token-confirm" role="group" aria-label={`Confirm deleting ${item.name}`}>
        <p>Delete {item.name}?{item.usage ? ` ${item.usage} rundown entr${item.usage === 1 ? 'y uses' : 'ies use'} it and will show nothing in its place.` : ''}</p>
        <div className="renderer-actions">
          <button className="text-button" type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          <button className="danger-button" type="button" onClick={() => run(() => media.remove(item))} disabled={busy}>Delete</button>
        </div>
      </div> : <div className="media-card-actions">
        <button className="icon-button" type="button" onClick={() => setRenaming(true)} disabled={busy} aria-label={`Rename ${item.name}`} title="Rename"><Pencil size={14} /></button>
        <button className="icon-button" type="button" onClick={() => replaceInput.current?.click()} disabled={busy} aria-label={`Replace ${item.name}`} title={`Replace with another .${item.extension} file (keeps the URL)`}><Upload size={14} /></button>
        <button className="icon-button" type="button" disabled={busy} aria-label={`Copy URL of ${item.name}`} title="Copy URL"
          onClick={() => navigator.clipboard?.writeText(item.url).then(() => onCopied(item), () => setError('Copy is not available.'))}><Copy size={14} /></button>
        <button className="icon-button" type="button" onClick={() => setConfirming(true)} disabled={busy} aria-label={`Delete ${item.name}`} title="Delete"><Trash2 size={14} /></button>
        <input ref={replaceInput} type="file" hidden accept={`.${item.extension}`} aria-label={`Replacement for ${item.name}`}
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => media.replace(item, file)); }} />
      </div>}
    </div>
  </li>;
}

export default function MediaCatalogView({ account, authLoading, media, onCopied = () => {}, children }) {
  const input = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState([]);
  async function upload(files) {
    if (!files?.length) return;
    setUploading(true);
    const failed = [];
    for (const file of files) {
      try { await media.upload(file); } catch (failure) { failed.push(`${file.name}: ${failure.message}`); }
    }
    setErrors(failed);
    setUploading(false);
    if (input.current) input.current.value = '';
  }
  return <section className="media-catalog" aria-labelledby="media-heading">
    <p className="eyebrow">MEDIA</p>
    <h1 id="media-heading">Media library</h1>
    <p className="renderer-lead">Images and other files for your graphics. Choose them in the properties of a graphic, e.g. as its image.
      Replacing a file keeps its address, so every graphic using it shows the new version.</p>
    {authLoading ? <p className="status" role="status">Loading account...</p>
      : !account ? <div className="empty-state"><strong>Sign in to manage your media.</strong>{children}</div>
        : <>
          <div className={`upload-zone${dragging ? ' is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload([...(event.dataTransfer.files ?? [])]); }}>
            <Upload size={22} />
            <div>
              <strong>Upload files</strong>
              <span>{media.extensions.length ? media.extensions.map((extension) => `.${extension}`).join(' ') : ''}{media.maxBytes ? `, up to ${formatBytes(media.maxBytes)} each` : ''}. Drop them here or choose files.</span>
            </div>
            <input ref={input} type="file" multiple hidden aria-label="Choose files to upload" onChange={(event) => upload([...(event.target.files ?? [])])} />
            <button className="primary-button" type="button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? 'Uploading...' : 'Choose files'}</button>
          </div>
          {errors.length > 0 && <div className="upload-result is-error" role="alert"><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
          {media.error && <p className="error-message" role="alert">{media.error}</p>}
          {!media.loading && !media.error && media.items.length === 0 && <div className="empty-state"><strong>No files yet.</strong><span>Upload images to use them in your graphics.</span></div>}
          <ul className="media-grid">{media.items.map((item) => <MediaCard key={item.id} item={item} media={media} onCopied={onCopied} />)}</ul>
        </>}
  </section>;
}
