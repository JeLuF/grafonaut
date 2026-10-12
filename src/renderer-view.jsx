import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import { requestJson } from './api.js';

const RENDER_WIDTH = 1920;
const RENDER_HEIGHT = 1080;

export function useRendererUrl(account) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setUrl('');
    setError('');
    if (!account) return;
    const controller = new AbortController();
    requestJson('/api/renderer', { signal: controller.signal }).then((response) => setUrl(response.url))
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [account]);
  return { url, setUrl, error, setError };
}

// Renders the renderer page at full 1920x1080 and scales it down to the frame width (640x360 by default).
// The sandbox keeps renderer code in an opaque origin, away from the app's cookies and storage.
export function RendererPreview({ account }) {
  const { url, error } = useRendererUrl(account);
  const [reloads, setReloads] = useState(0);
  const [scale, setScale] = useState(640 / RENDER_WIDTH);
  const frame = useRef(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([{ contentRect }]) => { if (contentRect.width) setScale(contentRect.width / RENDER_WIDTH); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [url]);
  if (!account) return null;
  return <section className="renderer-preview" aria-labelledby="renderer-preview-heading">
    <div className="renderer-preview-heading">
      <h2 id="renderer-preview-heading">Renderer preview</h2>
      {url && <div className="renderer-actions">
        <button className="icon-button" type="button" onClick={() => setReloads((count) => count + 1)} aria-label="Reload preview" title="Reload preview"><RefreshCw size={16} /></button>
        <a className="icon-button" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open renderer" title="Open renderer"><ExternalLink size={16} /></a>
      </div>}
    </div>
    <div className="renderer-preview-frame" ref={frame}>
      {error ? <p className="error-message" role="alert">{error}</p>
        : url ? <iframe key={reloads} src={url} title="Renderer preview" width={RENDER_WIDTH} height={RENDER_HEIGHT}
          sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" style={{ transform: `scale(${scale})` }} />
          : <p className="status" role="status">Loading preview...</p>}
    </div>
  </section>;
}

export default function RendererView({ account, authLoading }) {
  const { url, setUrl, error, setError } = useRendererUrl(account);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setConfirming(false); setRotated(false); }, [account]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setError('Copy is not available. Select the URL to copy it.'); }
  }
  async function rotate() {
    setRotating(true);
    setError('');
    try {
      const response = await requestJson('/api/renderer/token', { method: 'POST' });
      setUrl(response.url);
      setConfirming(false);
      setRotated(true);
      setCopied(false);
    } catch (failure) { setError(failure.message); }
    finally { setRotating(false); }
  }

  return (
    <section className="renderer-page" aria-labelledby="renderer-heading">
      <p className="eyebrow">RENDERER</p>
      <h1 id="renderer-heading">Your renderer</h1>
      <p className="renderer-lead">The renderer is the page that displays your graphics on air. Add its URL to OBS, vMix or any
        browser-based production tool; graphics you control from My Graphics appear on every renderer opened with your URL.</p>
      {authLoading ? <p className="status" role="status">Loading account...</p>
        : !account ? <div className="empty-state"><strong>Sign in to get your renderer URL.</strong><a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a></div>
          : <>
            <div className="renderer-card">
              <h2>Renderer URL</h2>
              {error && <p className="error-message" role="alert">{error}</p>}
              {!url ? !error && <p className="status" role="status">Loading renderer...</p> : <>
                <code className="renderer-url">{url}</code>
                <div className="renderer-actions">
                  <a className="primary-button" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Open renderer</a>
                  <button className="icon-button" type="button" onClick={copy} aria-label={copied ? 'Renderer URL copied' : 'Copy renderer URL'}
                    title={copied ? 'Copied' : 'Copy renderer URL'}>{copied ? <Check size={17} /> : <Copy size={17} />}</button>
                </div>
              </>}
              {rotated && <p className="renderer-notice" role="status">New URL created. Update your browser sources.</p>}
            </div>

            <div className="renderer-info">
              <section aria-labelledby="renderer-setup-heading">
                <h2 id="renderer-setup-heading">Use it as a browser source</h2>
                <ol>
                  <li>In OBS, add a <strong>Browser</strong> source (vMix: <strong>Web Browser</strong> input).</li>
                  <li>Paste your renderer URL.</li>
                  <li>Set the width and height to your canvas size, for example 1920 × 1080.</li>
                </ol>
                <p>The URL stays the same, so the source keeps working across sessions. You can open it in several places at
                  once, for example in OBS and in a browser tab for testing; all of them show the same graphics.</p>
              </section>
              <section aria-labelledby="renderer-token-heading">
                <h2 id="renderer-token-heading">Keep the URL private</h2>
                <p>The URL contains a secret token that links it to your account. Anyone who has it can watch your graphics. If
                  it leaked, create a new token: the old URL stops working immediately and you need to update your browser sources.</p>
                {confirming ? <div className="token-confirm" role="group" aria-label="Confirm new token">
                  <p>All renderer URLs with the current token stop working.</p>
                  <div className="renderer-actions">
                    <button className="text-button" type="button" onClick={() => setConfirming(false)} disabled={rotating}>Cancel</button>
                    <button className="danger-button" type="button" onClick={rotate} disabled={rotating}>{rotating ? 'Creating...' : 'Create new token'}</button>
                  </div>
                </div> : (url || error) && <button className="text-button" type="button" onClick={() => { setConfirming(true); setRotated(false); }}>
                  <KeyRound size={16} />New token</button>}
              </section>
            </div>
          </>}
    </section>
  );
}
