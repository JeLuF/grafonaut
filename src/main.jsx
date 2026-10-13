import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, ChevronLeft, ChevronRight, CircleCheck, CircleAlert, LayoutGrid, Lock, MonitorPlay, Plus, Search, X } from 'lucide-react';
import MyGraphicsView from './my-graphics.jsx';
import GraphicDetail from './graphic-detail.jsx';
import RendererView, { RendererPreview, useApiUrl } from './renderer-view.jsx';
import { RundownPanel, useRundowns } from './rundowns.jsx';
import PrivateCatalogView from './private-catalog.jsx';
import { GroupActionsPanel } from './group-actions.jsx';
import { FeatureRow, HeroArt, TwitchLogin, Wordmark } from './brand.jsx';
import { fetchRendererStatus, requestJson, triggerCustomAction, triggerGraphicAction, triggerGroupAction } from './api.js';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/outfit/800.css';
import './styles.css';

const PAGE_SIZE = 6;

export function parseRoute(hash) {
  if (hash === '#rundown' || hash === '#my-graphics') return { view: 'rundown' };
  if (hash === '#private') return { view: 'private' };
  if (hash === '#renderer') return { view: 'renderer' };
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

// Catalog cards: preview and title link to the detail page, the button adds the graphic to the current rundown.
function GraphicCards({ items, account, onAdd }) {
  return <div className="catalog-grid">
    {items.map((item) => <article className="graphic-card" key={item.versionId}>
      <a className="card-art-link" href={graphicHref(item)} tabIndex={-1} aria-hidden="true"><GraphicPreview item={item} /></a>
      <div className="card-body"><div><h3><a href={graphicHref(item)}>{item.display_name}</a></h3>
        <p className="card-description">{item.description || (item.isPrivate ? 'A private OGraf package.' : 'A published OGraf package.')}</p></div>
      <AddGraphicButton item={item} disabled={!account} onAdd={onAdd} /></div>
    </article>)}
  </div>;
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
    disabled={disabled || state === 'adding'} aria-busy={state === 'adding'} aria-label={label ? undefined : `Add ${item.display_name} to rundown`}
    title={disabled ? 'Sign in to add graphics' : added ? 'Added to rundown' : 'Add to rundown'}>
    {label ? <>{added ? <Check size={18} /> : <Plus size={18} />}{added ? 'Added to rundown' : label}</> : <Plus size={20} />}
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
  const [privateItems, setPrivateItems] = useState([]);
  const [privateLoading, setPrivateLoading] = useState(false);
  const [privateError, setPrivateError] = useState('');
  const [maxZipBytes, setMaxZipBytes] = useState(null);
  const [privatePage, setPrivatePage] = useState(0);
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

  const { url: apiUrl } = useApiUrl(account);
  const rundownState = useRundowns(account);
  const loadPrivateCatalog = useCallback(async () => {
    if (!account) { setPrivateItems([]); return; }
    setPrivateLoading(true);
    try {
      const response = await requestJson('/api/private/packages');
      setPrivateItems(response.items ?? []);
      setMaxZipBytes(response.maxZipBytes ?? null);
      setPrivateError('');
    } catch (error) { setPrivateError(error.message); }
    finally { setPrivateLoading(false); }
  }, [account]);
  useEffect(() => { void loadPrivateCatalog(); }, [loadPrivateCatalog]);
  const [groups, setGroups] = useState([]);
  const [groupsError, setGroupsError] = useState('');
  const [runningGroups, setRunningGroups] = useState(new Set());
  const loadGroups = useCallback(async () => {
    if (!account) { setGroups([]); return; }
    try {
      setGroups((await requestJson('/api/group-actions')).groups ?? []);
      setGroupsError('');
    } catch (error) { setGroupsError(error.message); }
  }, [account]);
  useEffect(() => { void loadGroups(); }, [loadGroups, rundownState.currentRundownId]);
  const rundownName = rundownState.current?.name;
  const [rendererStatus, setRendererStatus] = useState(null);
  const statusRequest = useRef(0);
  const refreshRendererStatus = useCallback(async () => {
    if (!apiUrl) { setRendererStatus(null); return; }
    const requestId = ++statusRequest.current;
    try {
      const next = await fetchRendererStatus(apiUrl);
      if (requestId === statusRequest.current) setRendererStatus(next);
    } catch (error) { if (requestId === statusRequest.current) setRendererStatus({ connections: 0, instances: new Map(), error: error.message }); }
  }, [apiUrl]);
  useEffect(() => {
    if (view !== 'rundown' || !apiUrl) return;
    void refreshRendererStatus();
    const timer = setInterval(refreshRendererStatus, 3000);
    return () => clearInterval(timer);
  }, [view, apiUrl, refreshRendererStatus]);
  // Each entry is one RenderTarget of the account's renderer, controlled through the public OGraf Server API.
  const controlledEntries = useMemo(() => entries.map((entry) => ({ ...entry,
    control: apiUrl ? { apiBaseUrl: apiUrl, rendererId: 'main', renderTarget: { entryId: entry.entryId }, graphicId: entry.versionId } : undefined,
    live: rendererStatus?.instances.get(entry.entryId) })), [entries, apiUrl, rendererStatus]);

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
      notify(`${item.display_name} added to ${rundownName ?? 'the rundown'}`);
      void refreshMyGraphics();
      void rundownState.reload();
    } catch (error) { notify(error.message, 'error'); throw error; }
  }

  async function deleteEntry(entry) {
    setPending((current) => new Set(current).add(entry.entryId));
    try {
      await requestJson(`/api/my-graphics/${encodeURIComponent(entry.entryId)}`, { method: 'DELETE' });
      graphicsRequest.current += 1;
      setMyLoading(false);
      setEntries((current) => current.filter((item) => item.entryId !== entry.entryId));
      notify(`${entry.label || entry.display_name} removed from the rundown`);
      void rundownState.reload();
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

  async function saveGroup(group, data) {
    const options = { method: group ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
    await requestJson(group ? `/api/group-actions/${encodeURIComponent(group.id)}` : '/api/group-actions', options);
    await loadGroups();
    notify(`${data.name} saved`);
  }

  async function deleteGroup(group) {
    await requestJson(`/api/group-actions/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
    await loadGroups();
    notify(`${group.name} deleted`);
  }

  // Runs a group action through the OGraf Server API extension (POST /x-actions/{id}), like any other controller would.
  async function runGroup(group) {
    setRunningGroups((current) => new Set(current).add(group.id));
    try {
      const { ran, failures } = await triggerGroupAction(apiUrl, group.id);
      if (!failures.length) notify(`${group.name} done`);
      else {
        notify(`${group.name}: ${failures.length} of ${ran} step${ran === 1 ? '' : 's'} failed. ${failures.map(({ entryName, message }) =>
          `${entryName ?? 'Missing graphic'}: ${message}`).join('; ')}`, 'error');
      }
    } catch (error) { notify(`${group.name}: ${error.message}`, 'error'); }
    finally {
      setRunningGroups((current) => { const next = new Set(current); next.delete(group.id); return next; });
      void refreshRendererStatus();
    }
  }

  async function runCustomAction(entry, action, payload) {
    const name = entry.label || entry.display_name;
    setPending((current) => new Set(current).add(entry.entryId));
    try {
      await triggerCustomAction(entry.control, action.id, payload, entry.schemaData);
      notify(`${name}: ${action.name}`);
    } catch (error) { notify(`${name}: ${error.message}`, 'error'); throw error; }
    finally {
      setPending((current) => { const next = new Set(current); next.delete(entry.entryId); return next; });
      void refreshRendererStatus();
    }
  }

  async function runAction(entry, action) {
    setPending((current) => new Set(current).add(entry.entryId));
    const name = entry.label || entry.display_name;
    try {
      const result = await triggerGraphicAction(entry.control, action, entry.schemaData);
      notify(result.notLoaded ? `${name} is not on air` : action === 'playAction' ? `${name} playing` : action === 'stopAction' ? `${name} stopped` : `${name} updated`);
    } catch (error) { notify(`${name}: ${error.message}`, 'error'); }
    finally {
      setPending((current) => { const next = new Set(current); next.delete(entry.entryId); return next; });
      void refreshRendererStatus();
    }
  }

  // Signed-out visitors get the website layout (top header, landing page); signed-in users the app with its sidebar.
  const signedOut = !authLoading && !account;
  return (
    <div className={signedOut ? 'site-layout' : 'app-layout'}>
    {signedOut ? <header className="site-header">
      <a className="brand-mark" href="#catalog" aria-label="Grafanaut home"><Wordmark /></a>
      <nav className="site-nav" aria-label="Site">
        <a href="#catalog" aria-current={view === 'catalog' || view === 'graphic' ? 'page' : undefined}>Templates</a>
        <a href="/api-docs/">API docs</a>
        <a href="https://ograf.ebu.io" target="_blank" rel="noopener noreferrer">OGraf</a>
      </nav>
      <TwitchLogin compact />
    </header> : <aside className="sidebar">
      <a className="brand-mark" href="#catalog" aria-label="Grafanaut home"><Wordmark /></a>
      <nav className="view-tabs" aria-label="Graphics views">
        <a href="#catalog" aria-current={view === 'catalog' || view === 'graphic' ? 'page' : undefined}><LayoutGrid size={17} />Catalog</a>
        <a href="#private" aria-current={view === 'private' ? 'page' : undefined}><Lock size={17} />Private catalog</a>
        <a href="#renderer" aria-current={view === 'renderer' ? 'page' : undefined}><MonitorPlay size={17} />Renderer</a>
      </nav>
      {account && <RundownPanel state={rundownState} viewing={view === 'rundown'} onOpen={() => { window.location.hash = '#rundown'; }}
        onDeleted={(rundown) => notify(`${rundown.name} deleted`)} onSwitched={(rundown) => {
        notify(`Switched to ${rundown.name}`);
        void refreshMyGraphics();
        void refreshRendererStatus();
      }} />}
      <div className="sidebar-account">
        {account && <span className="account-chip">{account.twitch_display_name ?? account.displayName}</span>}
      </div>
    </aside>}
    <main className={`app-shell${signedOut ? ' site-main' : ''}`}>
      {notice && <p className="notice" role="status">{notice}</p>}
      {view === 'rundown' ? authLoading ? <p className="status" role="status">Loading account...</p> : <MyGraphicsView account={account} rundownName={rundownName}
        groupActions={<GroupActionsPanel groups={groups} entries={controlledEntries} error={groupsError} running={runningGroups} disabled={!apiUrl}
          onRun={runGroup} onSave={saveGroup} onDelete={deleteGroup} />}
        entries={controlledEntries} rendererStatus={rendererStatus} loading={myLoading} error={myError} pending={pending} Preview={GraphicPreview} rendererPreview={<RendererPreview account={account} />} onRetry={refreshMyGraphics} onSave={saveEntry} onAction={runAction} onCustomAction={runCustomAction} onDelete={deleteEntry} onManifest={loadManifest} onReorder={reorderEntries} />
      : view === 'renderer' ? <RendererView account={account} authLoading={authLoading} />
      : view === 'private' ? <PrivateCatalogView account={account} authLoading={authLoading} count={privateItems.length} maxZipBytes={maxZipBytes}
        loading={privateLoading} error={privateError} onUploaded={loadPrivateCatalog}>
        {(() => {
          const pages = Math.max(1, Math.ceil(privateItems.length / PAGE_SIZE));
          const current = Math.min(privatePage, pages - 1);
          return <>
            <GraphicCards items={privateItems.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)} account={account} onAdd={addToMyGraphics} />
            <Pagination page={current} pageCount={pages} total={privateItems.length} onChange={setPrivatePage} />
          </>;
        })()}
      </PrivateCatalogView>
      : view === 'graphic' ? <GraphicDetail versionId={route.versionId}
        summary={[...catalog, ...privateItems].find((item) => item.versionId === route.versionId)}
        account={account} Preview={GraphicPreview} AddButton={AddGraphicButton} onAdd={addToMyGraphics} /> : <>
      {signedOut && <>
        <section className="hero">
          <div className="hero-text">
            <p className="eyebrow">OPEN GRAPHICS FOR LIVE CREATORS</p>
            <h1>Grafanaut</h1>
            <p className="hero-tagline">Beautiful stream graphics.<br />Ready to use.</p>
            <p className="hero-copy">Discover, customize and play animations based on the EBU OGraf standard. They work with OBS, vMix and any
              browser source, and you control them from the browser, Bitfocus Companion or a Stream Deck. Log in with your Twitch account and start creating.</p>
            <TwitchLogin />
          </div>
          <HeroArt />
        </section>
        <FeatureRow />
      </>}
      <section className="catalog-section" aria-labelledby="catalog-heading">
        <div className="section-heading" ref={catalogHeading}>
          {signedOut
            ? <div><p className="eyebrow">FEATURED ANIMATIONS</p><h2 id="catalog-heading">Ready to use. Easy to customize.</h2>
              <p className="section-copy">From lower thirds to scoreboards: find the right animation for your stream.</p></div>
            : <div><p className="eyebrow">THE LIBRARY</p><h2 id="catalog-heading">Published graphics</h2></div>}
          <label className="search-box"><Search size={16} aria-hidden="true" /><input aria-label="Search graphics" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search graphics" /></label>
        </div>
        {status && <p className="status">{status}</p>}
        {!status && filteredCatalog.length === 0 && <div className="empty-state"><strong>No graphics found.</strong><span>Seed packages will appear here after the first startup import.</span></div>}
        <GraphicCards items={pageItems} account={account} onAdd={addToMyGraphics} />
        <Pagination page={currentPage} pageCount={pageCount} total={filteredCatalog.length} onChange={changePage} />
      </section>
      {signedOut && <section className="cta-band" aria-labelledby="cta-heading">
        <div>
          <h2 id="cta-heading">Ready to launch your next stream?</h2>
          <p>Log in with Twitch and explore the Grafanaut template library.</p>
        </div>
        <TwitchLogin />
        <p className="cta-note">Great graphics.<br />Better streams.</p>
      </section>}
      </>}
      <footer><span>GRAFANAUT</span><span>Catalog, rundowns and rendering for <a href="https://ograf.ebu.io" target="_blank" rel="noopener noreferrer">OGraf</a> graphics · {new Date().getFullYear()}</span></footer>
      {toast && <Toast key={toast.id} toast={toast} onDismiss={setToast} />}
    </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
