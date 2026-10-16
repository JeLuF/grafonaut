import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Unplug } from 'lucide-react';
import { requestJson } from './api.js';
import { LoginButtons } from './brand.jsx';

const formatDate = (value) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

// Whether the server has the MCP interface enabled (MCP_BASE_URL), for the sidebar link. Unknown or failed: false.
export function useMcpEnabled(account) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(false);
    if (!account) return;
    const controller = new AbortController();
    requestJson('/api/mcp', { signal: controller.signal }).then((settings) => setEnabled(settings.enabled === true)).catch(() => {});
    return () => controller.abort();
  }, [account]);
  return enabled;
}

// The MCP interface (MCP.md): its URL for AI assistants, the apps connected to the account and what they changed.
function McpSettings({ account }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [disconnecting, setDisconnecting] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function load(signal) {
    try { setSettings(await requestJson('/api/mcp', { signal })); setError(''); }
    catch (failure) { if (!signal?.aborted) setError(failure.message); }
  }
  useEffect(() => {
    setSettings(null);
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [account]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(settings.url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setError('Copy is not available. Select the URL to copy it.'); }
  }
  async function disconnect(app) {
    setDisconnecting(app.id);
    try {
      await requestJson(`/api/mcp/apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
      await load();
    } catch (failure) { setError(failure.message); }
    finally { setDisconnecting(null); }
  }

  if (!settings) return error ? <p className="error-message" role="alert">{error}</p> : <p className="status" role="status">Loading...</p>;
  if (!settings.enabled) {
    return <div className="empty-state"><strong>The MCP interface is not enabled on this server.</strong>
      <span>Its administrator can turn it on with the MCP_BASE_URL setting.</span></div>;
  }
  return <>
    <section className="renderer-card" aria-labelledby="mcp-url-heading">
      <h2 id="mcp-url-heading">MCP URL</h2>
      <p className="renderer-card-copy">Add this URL as a remote MCP server (custom connector) in your assistant. You confirm the
        connection here in Grafonaut and choose whether the assistant may only read or also prepare rundowns.</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="renderer-actions">
        <code className="renderer-url mcp-url">{settings.url}</code>
        <button className="icon-button" type="button" onClick={copy} aria-label={copied ? 'MCP URL copied' : 'Copy MCP URL'}
          title={copied ? 'Copied' : 'Copy MCP URL'}>{copied ? <Check size={17} /> : <Copy size={17} />}</button>
      </div>
    </section>
    <section className="renderer-card" aria-labelledby="mcp-apps-heading">
      <h2 id="mcp-apps-heading">Connected apps</h2>
      {settings.apps.length ? <ul className="mcp-list">
        {settings.apps.map((app) => <li key={app.id}>
          <div>
            <strong>{app.name}</strong>
            <span className="muted">{app.scopes.includes('rundowns:write') ? 'Can read and prepare rundowns' : 'Can read rundowns'}
              {' · '}connected {formatDate(app.createdAt)}{app.lastUsedAt ? ` · last used ${formatDate(app.lastUsedAt)}` : ''}</span>
          </div>
          <button className="text-button" type="button" onClick={() => disconnect(app)} disabled={disconnecting === app.id}>
            <Unplug size={16} />{disconnecting === app.id ? 'Disconnecting...' : 'Disconnect'}</button>
        </li>)}
      </ul> : <p className="renderer-card-copy">No apps are connected.</p>}
    </section>
    {settings.activity.length > 0 && <section className="renderer-card" aria-labelledby="mcp-activity-heading">
      <h2 id="mcp-activity-heading">Recent changes by apps</h2>
      <ul className="mcp-list mcp-activity">
        {settings.activity.slice(0, 15).map((item) => <li key={item.id} className={item.ok ? undefined : 'is-refused'}>
          <span>{item.summary}</span>
          <span className="muted">{item.clientName} · {formatDate(item.createdAt)}</span>
        </li>)}
      </ul>
    </section>}
  </>;
}

export default function AssistantsView({ account, authLoading }) {
  return (
    <section className="renderer-page" aria-labelledby="assistants-heading">
      <p className="eyebrow">AI ASSISTANTS</p>
      <h1 id="assistants-heading">Prepare rundowns with AI</h1>
      <p className="renderer-lead">Let an AI assistant such as Claude set up rundowns for your events: it can find graphics, create
        rundowns, add entries with their properties and prepare group actions. It cannot control graphics on air.</p>
      {authLoading ? <p className="status" role="status">Loading account...</p>
        : !account ? <div className="empty-state"><strong>Sign in to connect an assistant.</strong><LoginButtons compact /></div>
          : <McpSettings account={account} />}
    </section>
  );
}
