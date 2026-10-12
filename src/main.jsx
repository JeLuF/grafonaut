import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
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

  useEffect(() => {
    Promise.all([
      fetch('/api/catalog').then((response) => response.json()),
      fetch('/api/auth/me').then((response) => response.json())
    ]).then(([catalogResponse, accountResponse]) => {
      setCatalog(catalogResponse.items ?? []);
      setAccount(accountResponse.account ?? null);
      setStatus('');
    }).catch(() => setStatus('Unable to reach the catalog service'));
  }, []);

  const filteredCatalog = catalog.filter((item) => {
    const haystack = `${item.display_name} ${item.description ?? ''}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  async function addToMyGraphics(versionId) {
    const response = await fetch('/api/my-graphics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId }) });
    setNotice(response.ok ? 'Added to My Graphics' : 'Unable to add this graphic');
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><span>O</span>GRAF</div>
        <div className="topbar-actions">
          {account ? <span className="account-chip">{account.displayName}</span> : <a className="login-link" href="/api/auth/twitch">Sign in with Twitch</a>}
        </div>
      </header>
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
        {notice && <p className="notice" role="status">{notice}</p>}
        {!status && filteredCatalog.length === 0 && <div className="empty-state"><strong>No graphics found.</strong><span>Seed packages will appear here after the first startup import.</span></div>}
        <div className="catalog-grid">
          {filteredCatalog.map((item) => <article className="graphic-card" key={item.versionId}>
            <GraphicPreview item={item} />
            <div className="card-body"><div><h3>{item.display_name}</h3><p>{item.description || 'A published OGraf package.'}</p></div><button type="button" onClick={() => addToMyGraphics(item.versionId)} disabled={!account} title={account ? 'Add to your working set' : 'Sign in to add graphics'}>＋</button></div>
          </article>)}
        </div>
      </section>
      <footer><span>OGRAF PLATFORM</span><span>Catalog preview · {new Date().getFullYear()}</span></footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
