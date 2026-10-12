import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, ChevronLeft, ChevronRight, CircleCheck, CircleAlert, LayoutGrid, List, Plus, X } from 'lucide-react';
import MyGraphicsView from './my-graphics.jsx';
import GraphicDetail from './graphic-detail.jsx';
import { requestJson, triggerGraphicAction } from './api.js';
import './styles.css';

const PAGE_SIZE = 6;

export function parseRoute(hash) {
  if (hash === '#my-graphics') return { view: 'my-graphics' };
  const match = /^#graphic\/(.+)$/.exec(hash);
  if (match) {
    try { return { view: 'graphic', versionId: decodeURIComponent(match[1]) }; } catch { /* fall through to catalog */ }
  }
  return { view: 'catalog' };
}

export const graphicHref = (item) => `#graphic/${encodeURIComponent(item.versionId)}`;

export function pageNumbers(count, current) {
  if (count <= 7) return Array.from({ length: count }, (_, page) => page);
  const pages = [...new Set([0, count - 1, current - 1, current, current + 1])].filter((page) => page >= 0 && page < count).sort((a, b) => a - b);
  return pages.flatMap((page, position) => position && page - pages[position - 1] > 1 ? [null, page] : [page]);
}

export function Pagination({ page, pageCount, total, onChange }) {
  if (pageCount <= 1) return null;
  const first = page * PAGE_SIZE + 1;
  return <nav className="pagination" aria-label="Catalog pages">
    <span className="pagination-range">{first}–{Math.min(first + PAGE_SIZE - 1, total)} of {total}</span>
    <div className="pagination-pages">
      <button className="icon-button" type="button" onClick={() => onChange(page - 1)} disabled={page === 0} aria-label="Previous page" title="Previous page"><ChevronLeft size={18} /></button>
      {pageNumbers(pageCount, page).map((number, position) => number === null
        ? <span key={`gap-${position}`} className="pagination-gap" aria-hidden="true">…</span>
        : <button key={number} className="icon-button" type="button" onClick={() => onChange(number)}
          aria-label={`Page ${number + 1}`} aria-current={number === page ? 'page' : undefined}>{number + 1}</button>)}
      <button className="icon-button" type="button" onClick={() => onChange(page + 1)} disabled={page === pageCount - 1} aria-label="Next page" title="Next page"><ChevronRight size={18} /></button>
    </div>
  </nav>;
}

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

export function AddGraphicButton({ item, disabled, onAdd, label }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  const adding = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function add() {
    if (adding.current) return;
    adding.current = true;
    clearTimeout(timer.current);
    setState('adding');
    try {
      await onAdd(item);
      setState('added');
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch { setState('idle'); }
    finally { adding.current = false; }
  }
  const added = state === 'added';
  return <button className={`add-graphic-button${label ? ' primary-button' : ''}${added ? ' is-added' : ''}`} type="button" onClick={add}
    disabled={disabled || state === 'adding'} aria-busy={state === 'adding'} aria-label={label ? undefined : `Add ${item.display_name} to My Graphics`}
    title={disabled ? 'Sign in to add graphics' : added ? 'Added to My Graphics' : 'Add to My Graphics'}>
    {label ? <>{added ? <Check size={18} /> : <Plus size={18} />}{added ? 'Added to My Graphics' : label}</> : <Plus size={20} />}
  </button>;
}

export function Toast({ toast, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(null), 5000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);
  return <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
    {toast.kind === 'error' ? <CircleAlert size={20} /> : <CircleCheck size={20} />}
    <span>{toast.message}</span>
    <button className="icon-button" type="button" onClick={() => onDismiss(null)} title="Dismiss notification" aria-label="Dismiss notification"><X size={16} /></button>
  </div>;
}

function App() {
  const [catalog, setCatalog] = useState([]);
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState(null);
  const [status, setStatus] = useState('Loading catalog');
  const [notice, setNotice] = useState('');
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const view = route.view;
  const [page, setPage] = useState(0);
  const catalogHeading = useRef(null);
  const catalogScroll = useRef(null);
  const previousView = useRef(view);
  const [entries, setEntries] = useState([]);
  const [myLoading, setMyLoading] = useState(false);
  const [myError, setMyError] = useState('');
  const [pending, setPending] = useState(new Set());
  const [authLoading, setAuthLoading] = useState(true);
  const graphicsRequest = useRef(0);
  const [toast, setToast] = useState(null);
  const toastId = useRef(0);

  function notify(message, kind = 'success') {
    setToast({ id: ++toastId.current, message, kind });
  }

  useEffect(() => {
    let active = true;
    requestJson('/api/catalog').then((response) => {
      if (active) { setCatalog(response.items ?? []); setStatus(''); }
    }).catch((error) => { if (active) setStatus(error.message); });
    requestJson('/api/auth/me').then((response) => {
      if (active) setAccount(response.account ?? null);
    }).catch((error) => { if (active) setNotice(error.message); })
      .finally(() => { if (active) setAuthLoading(false); });
    const changeView = () => {
      const next = parseRoute(window.location.hash);
      if (previousView.current === 'catalog' && next.view === 'graphic') catalogScroll.current = window.scrollY;
      setRoute(next);
    };
    window.addEventListener('hashchange', changeView);
    return () => { active = false; window.removeEventListener('hashchange', changeView); };
  }, []);

  useLayoutEffect(() => {
    if (previousView.current === view && view !== 'graphic') return;
    if (view === 'graphic') window.scrollTo?.(0, 0);
    else if (view === 'catalog' && previousView.current === 'graphic' && catalogScroll.current !== null) window.scrollTo?.(0, catalogScroll.current);
    if (view !== 'graphic') catalogScroll.current = null;
    previousView.current = view;
  }, [view, route.versionId]);

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
  const pageCount = Math.max(1, Math.ceil(filteredCatalog.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filteredCatalog.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function changePage(next) {
    setPage(next);
    const heading = catalogHeading.current;
    if (heading && heading.getBoundingClientRect().top < 0) heading.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  async function addToMyGraphics(item) {
    try {
      await requestJson('/api/my-graphics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: item.versionId }) });
      notify(`${item.display_name} added to My Graphics`);
      void refreshMyGraphics();
    } catch (error) { notify(error.message, 'error'); throw error; }
  }

  async function deleteEntry(entry) {
    setPending((current) => new Set(current).add(entry.entryId));
    try {
      await requestJson(`/api/my-graphics/${encodeURIComponent(entry.entryId)}`, { method: 'DELETE' });
      graphicsRequest.current += 1;
      setMyLoading(false);
      setEntries((current) => current.filter((item) => item.entryId !== entry.entryId));
      notify(`${entry.label || entry.display_name} deleted from My Graphics`);
    } catch (error) { notify(error.message, 'error'); throw error; }
    finally { setPending((current) => { const next = new Set(current); next.delete(entry.entryId); return next; }); }
  }

  async function loadManifest(entry) {
    const response = await requestJson(`/api/my-graphics/${encodeURIComponent(entry.entryId)}/manifest`);
    return response.manifest;
  }

  async function reorderEntries(entryIds) {
    await requestJson('/api/my-graphics/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryIds }) });
    graphicsRequest.current += 1;
    setMyLoading(false);
    setEntries((current) => {
      const byId = new Map(current.map((entry) => [entry.entryId, entry]));
      const orderedIds = new Set(entryIds);
      return [...entryIds.map((entryId) => byId.get(entryId)).filter(Boolean), ...current.filter((entry) => !orderedIds.has(entry.entryId))];
    });
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
        <a href="#catalog" aria-current={view !== 'my-graphics' ? 'page' : undefined}><LayoutGrid size={17} />Catalog</a>
        <a href="#my-graphics" aria-current={view === 'my-graphics' ? 'page' : undefined}><List size={17} />My Graphics{account && <span className="entry-count">{entries.length}</span>}</a>
      </nav>
      {notice && <p className="notice" role="status">{notice}</p>}
      {view === 'my-graphics' ? authLoading ? <p className="status" role="status">Loading account...</p> : <MyGraphicsView account={account} entries={entries} loading={myLoading} error={myError} pending={pending} Preview={GraphicPreview} onRetry={refreshMyGraphics} onSave={saveEntry} onAction={runAction} onDelete={deleteEntry} onManifest={loadManifest} onReorder={reorderEntries} />
      : view === 'graphic' ? <GraphicDetail versionId={route.versionId} summary={catalog.find((item) => item.versionId === route.versionId)}
        account={account} Preview={GraphicPreview} AddButton={AddGraphicButton} onAdd={addToMyGraphics} /> : <>
      <section className="hero">
        <p className="eyebrow">PUBLIC CATALOG / MVP</p>
        <h1>Broadcast graphics,<br /><em>ready to play.</em></h1>
        <p className="hero-copy">Browse the shared OGraf library and build a working set for your next live production.</p>
      </section>
      <section className="catalog-section" aria-labelledby="catalog-heading">
        <div className="section-heading" ref={catalogHeading}>
          <div><p className="eyebrow">THE LIBRARY</p><h2 id="catalog-heading">Published graphics</h2></div>
          <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search graphics" /></label>
        </div>
        {status && <p className="status">{status}</p>}
        {!status && filteredCatalog.length === 0 && <div className="empty-state"><strong>No graphics found.</strong><span>Seed packages will appear here after the first startup import.</span></div>}
        <div className="catalog-grid">
          {pageItems.map((item) => <article className="graphic-card" key={item.versionId}>
            <a className="card-art-link" href={graphicHref(item)} tabIndex={-1} aria-hidden="true"><GraphicPreview item={item} /></a>
            <div className="card-body"><div><h3><a href={graphicHref(item)}>{item.display_name}</a></h3><p className="card-description">{item.description || 'A published OGraf package.'}</p></div><AddGraphicButton item={item} disabled={!account} onAdd={addToMyGraphics} /></div>
          </article>)}
        </div>
        <Pagination page={currentPage} pageCount={pageCount} total={filteredCatalog.length} onChange={changePage} />
      </section>
      </>}
      <footer><span>OGRAF PLATFORM</span><span>Catalog preview · {new Date().getFullYear()}</span></footer>
      {toast && <Toast key={toast.id} toast={toast} onDismiss={setToast} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
