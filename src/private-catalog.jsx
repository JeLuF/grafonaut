import React, { useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Upload } from 'lucide-react';
import { requestJson } from './api.js';
import { LoginButtons } from './brand.jsx';

// Uploads one .ograf.zip as the request body; the server validates it and stores every graphic as a private version.
export async function uploadPackage(file) {
  try {
    return await requestJson('/api/private/packages', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
  } catch (failure) {
    // A 413 without the app's JSON message comes from a proxy in front of the app (nginx allows 1 MB by default).
    if (failure.status === 413 && !failure.payload?.error) throw Object.assign(new Error("The file was refused by the web server's upload limit (e.g. nginx client_max_body_size)"), { status: 413, payload: {} });
    throw failure;
  }
}

function UploadResult({ result }) {
  if (result.error) {
    return <div className="upload-result is-error" role="alert">
      <p><CircleAlert size={18} />{result.fileName}: {result.error}</p>
      {result.details?.length > 0 && <ul>{result.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
    </div>;
  }
  const names = (items) => items.map((item) => `${item.name} v${item.versionLabel}`).join(', ');
  return <div className="upload-result" role="status">
    {result.saved.length > 0 && <p><CircleCheck size={18} />Uploaded {names(result.saved)}.</p>}
    {result.skipped.length > 0 && <p><CircleCheck size={18} />Already uploaded: {names(result.skipped)}.</p>}
    {result.warnings?.length > 0 && <>
      <p className="upload-note">The manifest is not strictly valid; these assumptions were made:</p>
      <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </>}
  </div>;
}

// The account's own uploads. `children` renders the graphics (cards with "Add to rundown").
export default function PrivateCatalogView({ account, authLoading, count, maxZipBytes, loading, error, onUploaded, children }) {
  const input = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState(null);

  async function upload(file) {
    if (!file || uploading) return;
    setUploading(true);
    setResult(null);
    try {
      const response = await uploadPackage(file);
      setResult({ ...response, fileName: file.name });
      await onUploaded();
    } catch (failure) {
      setResult({ fileName: file.name, error: failure.message, details: failure.payload?.details ?? [] });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <section className="private-catalog" aria-labelledby="private-heading">
      <p className="eyebrow">PRIVATE CATALOG</p>
      <h1 id="private-heading">Your graphics</h1>
      <p className="renderer-lead">Graphics you upload are only visible to you. Add them to a rundown like any catalog graphic.
        Uploading a graphic with the same manifest id again adds a new version; rundown entries keep the version they were added with.</p>
      {authLoading ? <p className="status" role="status">Loading account...</p>
        : !account ? <div className="empty-state"><strong>Sign in to upload your own graphics.</strong><LoginButtons compact /></div>
          : <>
            <div className={`upload-zone${dragging ? ' is-dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files?.[0]); }}>
              <Upload size={22} />
              <div>
                <strong>Upload an OGraf package</strong>
                <span>A .ograf.zip file{maxZipBytes ? `, up to ${Math.round(maxZipBytes / 1024 / 1024 * 10) / 10} MB` : ''}. Drop it here or choose a file.</span>
              </div>
              <input ref={input} id="package-file" type="file" accept=".zip,application/zip" hidden onChange={(event) => upload(event.target.files?.[0])} />
              <button className="primary-button" type="button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? 'Uploading...' : 'Choose file'}</button>
            </div>
            {result && <UploadResult result={result} />}
            <div className="section-heading private-heading">
              <div><h2>Uploaded graphics</h2></div>
              {count > 0 && <span className="status">{count} graphic{count === 1 ? '' : 's'}</span>}
            </div>
            {error && <p className="error-message" role="alert">{error}</p>}
            {loading && <p className="status" role="status">Loading private catalog...</p>}
            {!loading && !error && count === 0 && <div className="empty-state"><strong>No uploads yet.</strong><span>Upload a .ograf.zip package to get started.</span></div>}
            {children}
          </>}
    </section>
  );
}
