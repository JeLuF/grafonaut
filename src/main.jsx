import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutGrid, List, Plus } from 'lucide-react';
import MyGraphicsView from './my-graphics.jsx';
import { requestJson, triggerGraphicAction } from './api.js';
import './styles.css';

function GraphicPreview({ item }) {
  const [failedThumbnail, setFailedThumbnail] = useState(null);
  const showThumbnail = item.thumbnailUrl && failedThumbnail !== item.thumbnailUrl;
  return (
    <div className={`card-art${showThumbnail ? ' has-thumbnail' : ''}`}>
      {showThumbnail
        ? <img className="card-thumbnail" src={item.thumbnailUrl} alt={`${item.display_name} preview`} loading="lazy" decoding="async" onError={() => setFailedThumbnail(item.thumbnailUrl)} />
        : <span className="art-index">{String(item.display_name ?? 'OG').slice(0, 2).toUpperCase()}</span>}
      <span className="version-tag">v{item.versionLabel}</span>
    </div>
  );
}

function App() {
  const [catalog, setCatalog] = useState([]);
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState(null);
  const [status, setStatus] = useState('Loading catalog');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState(window.location.hash === '#my-graphics' ? 'my-graphics' : 'catalog');
  const [entries, setEntries] = useState([]);
  const [myLoading, setMyLoading] = useState(false);
  const [myError, setMyError] = useState('');
  const [pending, setPending] = useState(new Set());
  const [authLoading, setAuthLoading] = useState(true);
  const graphicsRequest = useRef(0);

  useEffect(() => {
    let active = true;
    requestJson('/api/catalog').then((response) => {
      if (active) { setCatalog(response.items ?? []); setStatus(''); }
    }).catch((error) => { if (active) setStatus(error.message); });
    requestJson('/api/auth/me').then((response) => {
      if (active) setAccount(response.account ?? null);
    }).catch((error) => { if (active) setNotice(error.message); })
      .finally(() => { if (active) setAuthLoading(false); });
    const changeView = () => setView(window.location.hash === '#my-graphics' ? 'my-graphics' : 'catalog');
    window.addEventListener('hashchange', changeView);
    return () => { active = false; window.removeEventListener('hashchange', changeView); };
  }, []);

  useEffect(() => {
    if (!account) { setEntries([]); return; }
    const controller = new AbortController();
    const requestId = ++graphicsRequest.current;
    setMyLoading(true);
    setMyError('');
    requestJson('/api/my-graphics', { signal: controller.signal }).then((response) => {
      if (requestId === graphicsRequest.current) setEntries(response.items ?? []);
    }).catch((error) => { if (!controller.signal.aborted && requestId === graphicsRequest.current) setMyError(error.message); })
      .finally(() => { if (!controller.signal.aborted && requestId === graphicsRequest.current) setMyLoading(false); });
    return () => controller.abort();
  }, [account]);

  async function refreshMyGraphics() {
    const requestId = ++graphicsRequest.current;
    setMyLoading(true);
    setMyError('');
    try {
      const response = await requestJson('/api/my-graphics');
      if (requestId === graphicsRequest.current) setEntries(response.items ?? []);
    } catch (error) { if (requestId === graphicsRequest.current) setMyError(error.message); }
    finally { if (requestId === graphicsRequest.current) setMyLoading(false); }
  }

  const filteredCatalog = catalog.filter((item) => {
    const haystack = `${item.display_name} ${item.description ?? ''}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  async function addToMyGraphics(versionId) {
    try {
      await requestJson('/api/my-graphics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId }) });
      setNotice('Added to My Graphics');
      await refreshMyGraphics();
    } catch (error) { setNotice(error.message); }
  }

  async function saveEntry(entryId, changes) {
    setPending((current) => new Set(current).add(entryId));
    try {
      await requestJson(`/api/my-graphics/${encodeURIComponent(entryId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setEntries((current) => current.map((entry) => entry.entryId === entryId ? { ...entry, ...changes } : entry));
    } finally { setPending((current) => { const next = new Set(current); next.delete(entryId); return next; }); }
  }

  async function runAction(entry, action) {
    setPending((current) => new Set(current).add(entry.entryId));
    try {
      await triggerGraphicAction(entry.control, action, entry.schemaData);
      setNotice(action === 'playAction' ? 'Play completed' : action === 'stopAction' ? 'Stop completed' : 'Update completed');
    } catch (error) { setNotice(error.message); }
    finally { setPending((current) => { const next = new Set(current); next.delete(entry.entryId); return next; }); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><span>O</span>GRAF</div>
        <div className="topbar-actions">
          {account ? <span className="account-chip">{account.twitch_display_name ?? account.displayName}</span> : <a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a>}
        </div>
      </header>
      <nav className="view-tabs" aria-label="Graphics views">
        <a href="#catalog" aria-current={view === 'catalog' ? 'page' : undefined}><LayoutGrid size={17} />Catalog</a>
        <a href="#my-graphics" aria-current={view === 'my-graphics' ? 'page' : undefined}><List size={17} />My Graphics{account && <span className="entry-count">{entries.length}</span>}</a>
      </nav>
      {notice && <p className="notice" role="status">{notice}</p>}
      {view === 'my-graphics' ? authLoading ? <p className="status" role="status">Loading account...</p> : <MyGraphicsView account={account} entries={entries} loading={myLoading} error={myError} pending={pending} Preview={GraphicPreview} onRetry={refreshMyGraphics} onSave={saveEntry} onAction={runAction} /> : <>
      <section className="hero">
        <p className="eyebrow">PUBLIC CATALOG / MVP</p>
        <h1>Broadcast graphics,<br /><em>ready to play.</em></h1>
        <p className="hero-copy">Browse the shared OGraf library and build a working set for your next live production.</p>
      </section>
      <section className="catalog-section" aria-labelledby="catalog-heading">
        <div className="section-heading">
          <div><p className="eyebrow">THE LIBRARY</p><h2 id="catalog-heading">Published graphics</h2></div>
          <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search graphics" /></label>
        </div>
        {status && <p className="status">{status}</p>}
        {!status && filteredCatalog.length === 0 && <div className="empty-state"><strong>No graphics found.</strong><span>Seed packages will appear here after the first startup import.</span></div>}
        <div className="catalog-grid">
          {filteredCatalog.map((item) => <article className="graphic-card" key={item.versionId}>
            <GraphicPreview item={item} />
            <div className="card-body"><div><h3>{item.display_name}</h3><p>{item.description || 'A published OGraf package.'}</p></div><button type="button" onClick={() => addToMyGraphics(item.versionId)} disabled={!account} aria-label={`Add ${item.display_name} to My Graphics`} title={account ? 'Add to My Graphics' : 'Sign in to add graphics'}><Plus size={20} /></button></div>
          </article>)}
        </div>
      </section>
      </>}
      <footer><span>OGRAF PLATFORM</span><span>Catalog preview · {new Date().getFullYear()}</span></footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
