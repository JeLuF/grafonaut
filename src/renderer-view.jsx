import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import { requestJson } from './api.js';

const RENDER_WIDTH = 1920;
const RENDER_HEIGHT = 1080;

function useTokenUrl(account, kind) {
  const [url, setUrl] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setUrl('');
    setError('');
    if (!account) return;
    const controller = new AbortController();
    requestJson(`/api/tokens/${kind}`, { signal: controller.signal }).then((response) => { setUrl(response.url); setIsolated(response.isolated === true); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [account, kind]);
  return { url, setUrl, isolated, error, setError };
}

export const useRendererUrl = (account) => useTokenUrl(account, 'renderer');
export const useApiUrl = (account) => useTokenUrl(account, 'api');

// Renders the renderer page at full 1920x1080 and scales it down to the frame width (640x360 by default).
// The sandbox keeps renderer code in an opaque origin, away from the app's cookies and storage. Only a renderer on
// its own host (RENDERER_HOST) may keep its origin, which graphics with nested same-origin pages need.
export function RendererPreview({ account }) {
  const { url, isolated, error } = useRendererUrl(account);
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
          sandbox={isolated ? 'allow-scripts allow-same-origin' : 'allow-scripts'} referrerPolicy="no-referrer" loading="lazy" style={{ transform: `scale(${scale})` }} />
          : <p className="status" role="status">Loading preview...</p>}
    </div>
  </section>;
}

const tokenTexts = {
  renderer: { title: 'Renderer URL', open: 'Open renderer', copy: 'renderer URL', newToken: 'New renderer token',
    warning: 'All renderer URLs with the current token stop working.', created: 'New URL created. Update your browser sources.' },
  api: { title: 'OGraf Server API', open: 'Open API', copy: 'API URL', newToken: 'New API token',
    warning: 'Controllers using the current API URL stop working.', created: 'New API URL created. Update your controllers.' }
};

// Shows one secret account URL with open/copy actions and a confirmed "new token" action that invalidates the old URL.
function TokenCard({ account, kind, children }) {
  const text = tokenTexts[kind];
  const { url, setUrl, error, setError } = useTokenUrl(account, kind);
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
      const response = await requestJson(`/api/tokens/${kind}`, { method: 'POST' });
      setUrl(response.url);
      setConfirming(false);
      setRotated(true);
      setCopied(false);
    } catch (failure) { setError(failure.message); }
    finally { setRotating(false); }
  }

  return <section className="renderer-card" aria-labelledby={`${kind}-url-heading`}>
    <h2 id={`${kind}-url-heading`}>{text.title}</h2>
    {children}
    {error && <p className="error-message" role="alert">{error}</p>}
    {!url && !error && <p className="status" role="status">Loading URL...</p>}
    {url && <code className="renderer-url">{url}</code>}
    {(url || error) && <div className="renderer-actions">
      {url && <>
        <a className="primary-button" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />{text.open}</a>
        <button className="icon-button" type="button" onClick={copy} aria-label={copied ? `${text.copy[0].toUpperCase()}${text.copy.slice(1)} copied` : `Copy ${text.copy}`}
          title={copied ? 'Copied' : `Copy ${text.copy}`}>{copied ? <Check size={17} /> : <Copy size={17} />}</button>
      </>}
      {!confirming && <button className="text-button token-button" type="button" onClick={() => { setConfirming(true); setRotated(false); }}>
        <KeyRound size={16} />{text.newToken}</button>}
    </div>}
    {rotated && <p className="renderer-notice" role="status">{text.created}</p>}
    {confirming && <div className="token-confirm" role="group" aria-label={`Confirm ${text.newToken.toLowerCase()}`}>
      <p>{text.warning}</p>
      <div className="renderer-actions">
        <button className="text-button" type="button" onClick={() => setConfirming(false)} disabled={rotating}>Cancel</button>
        <button className="danger-button" type="button" onClick={rotate} disabled={rotating}>{rotating ? 'Creating...' : 'Create new token'}</button>
      </div>
    </div>}
  </section>;
}

export default function RendererView({ account, authLoading }) {
  return (
    <section className="renderer-page" aria-labelledby="renderer-heading">
      <p className="eyebrow">RENDERER</p>
      <h1 id="renderer-heading">Your renderer</h1>
      <p className="renderer-lead">The renderer is the page that displays your graphics on air. Add its URL to OBS, vMix or any
        browser-based production tool; graphics you control from My Graphics appear on every renderer opened with your URL.</p>
      {authLoading ? <p className="status" role="status">Loading account...</p>
        : !account ? <div className="empty-state"><strong>Sign in to get your renderer URL.</strong><a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a></div>
          : <>
            <TokenCard account={account} kind="renderer" />
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
                <h2 id="renderer-token-heading">Keep your URLs private</h2>
                <p>The renderer URL and the API URL each contain their own secret token. Anyone with the renderer URL can watch
                  your graphics; anyone with the API URL can control them. If a URL leaked, create a new token for it: the old URL
                  stops working immediately, and you need to update your browser sources or controllers.</p>
              </section>
            </div>
            <TokenCard account={account} kind="api">
              <p className="renderer-card-copy">Control your graphics from Bitfocus Companion, a Stream Deck or your own scripts
                through the <a href="https://ograf.ebu.io" target="_blank" rel="noopener noreferrer">OGraf Server API</a>. Use
                this URL as the API base; it uses a different token than the renderer.</p>
            </TokenCard>
          </>}
    </section>
  );
}
