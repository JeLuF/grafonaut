import React, { useCallback, useEffect, useId, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, FileJson, Mail, Play, Plus, RefreshCw, ScrollText, Square, Tag, User, X, Zap } from 'lucide-react';
import { requestJson } from './api.js';
import { ActionMenu, EntryDialog } from './my-graphics.jsx';
import { LoginButtons } from './brand.jsx';

const sourceLabels = { seed_builtin: 'Built-in library', seed_volume: 'Imported library', user_upload: 'Community upload' };
const standardActions = {
  playAction: { name: 'Play', icon: Play, description: 'Animates the graphic in.' },
  updateAction: { name: 'Update', icon: RefreshCw, description: 'Applies new property values while on air.' },
  stopAction: { name: 'Stop', icon: Square, description: 'Animates the graphic out.' }
};

function formatConstraint(value) {
  if (!value) return null;
  if (value.exact != null) return String(value.exact);
  const range = value.min != null || value.max != null ? `${value.min ?? '0'}–${value.max ?? '∞'}` : null;
  if (range && value.ideal != null) return `${range} (ideal ${value.ideal})`;
  return range ?? (value.ideal != null ? `~${value.ideal}` : null);
}

export function formatRequirement(requirement) {
  const width = formatConstraint(requirement.width);
  const height = formatConstraint(requirement.height);
  const frameRate = formatConstraint(requirement.frameRate);
  const parts = [];
  if (width || height) parts.push(`${width ?? 'any'} × ${height ?? 'any'} px`);
  if (frameRate) parts.push(`${frameRate} fps`);
  return parts.join(' @ ') || 'No constraints';
}

function formatDuration(duration) {
  return typeof duration === 'number' ? `${Number((duration / 1000).toFixed(2))} s` : null;
}

export function ThumbnailCarousel({ images, name, fallback }) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(() => new Set());
  if (!images.length) return <div className="carousel carousel-empty">{fallback}</div>;
  const current = Math.min(index, images.length - 1);
  const image = images[current];
  const move = (step) => setIndex((current + step + images.length) % images.length);
  function onKeyDown(event) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  }
  return (
    <section className="carousel" aria-roledescription="carousel" aria-label={`${name} thumbnails`} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="carousel-stage">
        {failed.has(image.url)
          ? <span className="carousel-missing">Preview unavailable</span>
          : <img key={image.url} src={image.url} alt={`${name} thumbnail ${current + 1} of ${images.length}`} decoding="async"
            onError={() => setFailed((set) => new Set(set).add(image.url))} />}
        {images.length > 1 && <>
          <button className="carousel-nav carousel-prev" type="button" onClick={() => move(-1)} aria-label="Previous thumbnail" title="Previous thumbnail"><ChevronLeft size={22} /></button>
          <button className="carousel-nav carousel-next" type="button" onClick={() => move(1)} aria-label="Next thumbnail" title="Next thumbnail"><ChevronRight size={22} /></button>
        </>}
      </div>
      <div className="carousel-caption" aria-live="polite">
        <span>{current + 1} / {images.length}</span>
        <span>{[image.width && image.height ? `${image.width} × ${image.height}` : null, image.animated ? 'Animated' : null].filter(Boolean).join(' · ')}</span>
      </div>
      {images.length > 1 && <div className="carousel-strip">
        {images.map((thumbnail, position) => <button key={thumbnail.url} type="button" onClick={() => setIndex(position)}
          aria-label={`Show thumbnail ${position + 1}`} aria-current={position === current ? 'true' : undefined}>
          {!failed.has(thumbnail.url) && <img src={thumbnail.url} alt="" loading="lazy" decoding="async" />}
        </button>)}
      </div>}
    </section>
  );
}

// Tags of a catalog animation. Everyone sees them (each links to the catalog filtered by it); admins add and remove them.
export function TagEditor({ versionId, tags, editable, suggestions = [], onSaved }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const listId = useId();
  async function save(next) {
    setSaving(true);
    setError('');
    try {
      const response = await requestJson(`/api/admin/catalog/${encodeURIComponent(versionId)}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: next }) });
      onSaved(response.tags);
      setDraft('');
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  function add(event) {
    event.preventDefault();
    const tag = draft.replace(/\s+/g, ' ').trim();
    if (!tag) return;
    // An existing tag keeps its spelling ("Lower third", not "lower THIRD").
    const known = suggestions.find((candidate) => candidate.toLowerCase() === tag.toLowerCase()) ?? tag;
    if (tags.some((existing) => existing.toLowerCase() === known.toLowerCase())) { setDraft(''); return; }
    void save([...tags, known]);
  }
  if (!editable && !tags.length) return null;
  return <div className="detail-tags">
    <ul className="tag-list" aria-label="Tags">
      {tags.map((tag) => <li key={tag} className="tag-chip">
        <a href={`#catalog?tag=${encodeURIComponent(tag)}`}><Tag size={12} aria-hidden="true" />{tag}</a>
        {editable && <button type="button" className="tag-remove" disabled={saving} onClick={() => save(tags.filter((candidate) => candidate !== tag))}
          aria-label={`Remove tag ${tag}`} title="Remove tag"><X size={12} /></button>}
      </li>)}
    </ul>
    {editable && <form className="tag-add" onSubmit={add}>
      <input value={draft} onChange={(event) => setDraft(event.target.value)} list={listId} maxLength={40} placeholder="Add a tag, e.g. lower third"
        aria-label="New tag" disabled={saving} />
      <datalist id={listId}>{suggestions.filter((tag) => !tags.includes(tag)).map((tag) => <option key={tag} value={tag} />)}</datalist>
      <button className="text-button" type="submit" disabled={saving || !draft.trim()}><Plus size={14} />Add tag</button>
    </form>}
    {error && <p className="error-message" role="alert">{error}</p>}
  </div>;
}

export default function GraphicDetail({ versionId, summary, account, Preview, AddButton, onAdd, FavouriteButton, favourites, tagSuggestions = [], onTagsChanged }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [showManifest, setShowManifest] = useState(false);
  const [showLicense, setShowLicense] = useState(false);
  const loadManifest = useCallback(async () => (await requestJson(`/api/catalog/${encodeURIComponent(versionId)}/manifest`)).manifest, [versionId]);
  const loadLicense = useCallback(async () => (await requestJson(`/api/catalog/${encodeURIComponent(versionId)}/license`)).license, [versionId]);
  useEffect(() => {
    setShowManifest(false);
    setShowLicense(false);
    const controller = new AbortController();
    setItem(null);
    setError('');
    requestJson(`/api/catalog/${encodeURIComponent(versionId)}`, { signal: controller.signal })
      .then((response) => setItem(response.item))
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [versionId]);

  const graphic = item ?? summary;
  const isPrivate = Boolean(graphic?.isPrivate);
  const back = isPrivate ? <a className="back-link" href="#private"><ArrowLeft size={16} />Back to private catalog</a>
    : <a className="back-link" href="#catalog"><ArrowLeft size={16} />Back to catalog</a>;
  if (!graphic) {
    return <section className="graphic-detail">{back}
      {error ? <div className="empty-state"><strong>Graphic unavailable.</strong><span>{error}</span></div> : <p className="status" role="status">Loading graphic...</p>}
    </section>;
  }
  const author = item?.author;
  const images = item?.thumbnails ?? [];
  return (
    <article className="graphic-detail" aria-labelledby="graphic-heading">
      {back}
      <div className="detail-layout">
        {item
          ? <ThumbnailCarousel key={item.versionId} images={images} name={graphic.display_name} fallback={<Preview item={graphic} />} />
          : <div className="carousel carousel-empty"><Preview item={graphic} /></div>}
        <div className="detail-summary">
          <p className="eyebrow">{isPrivate ? 'PRIVATE GRAPHIC' : 'OGRAF GRAPHIC'} · v{graphic.versionLabel}</p>
          <h1 id="graphic-heading">{graphic.display_name}</h1>
          {item && !isPrivate && <TagEditor versionId={item.versionId} tags={item.tags ?? []} editable={Boolean(account?.is_approver)} suggestions={tagSuggestions}
            onSaved={(tags) => { setItem((current) => ({ ...current, tags })); onTagsChanged?.(item.packageId, tags); }} />}
          <div className="detail-cta">
            <AddButton item={graphic} disabled={!account} onAdd={onAdd} label="Add to rundown" />
            {account && FavouriteButton && <FavouriteButton item={graphic} favourites={favourites} label />}
            <ActionMenu label={`More options for ${graphic.display_name}`} items={[
              { key: 'manifest', label: 'Show manifest', icon: FileJson, onSelect: () => setShowManifest(true) },
              item?.hasLicense && { key: 'license', label: 'Show license', icon: ScrollText, onSelect: () => setShowLicense(true) }
            ]} />
            {!account && <LoginButtons compact />}
          </div>
          <dl className="detail-facts">
            <div><dt>Creator</dt><dd>{!isPrivate && item?.creator
              ? <a href={`#catalog?creator=${encodeURIComponent(item.creator)}`} title={`All graphics by ${item.creator}`}>{item.creator}</a>
              : author?.name ?? 'Unknown'}</dd></div>
            {item?.source && <div><dt>Source</dt><dd>{sourceLabels[item.source] ?? item.source}</dd></div>}
            {item?.publishedAt && <div><dt>Published</dt><dd>{new Date(item.publishedAt).toLocaleDateString()}</dd></div>}
            {item?.manifestId && <div><dt>Graphic ID</dt><dd className="mono">{item.manifestId}</dd></div>}
          </dl>
        </div>
      </div>
      {showManifest && <EntryDialog entry={summary ?? graphic} mode="manifest" onManifest={loadManifest} onClose={() => setShowManifest(false)} />}
      {showLicense && <EntryDialog entry={summary ?? graphic} mode="license" onLicense={loadLicense} onClose={() => setShowLicense(false)} />}
      {error && <p className="error-message" role="alert">{error}</p>}
      {!item && !error && <p className="status" role="status">Loading details...</p>}

      <section className="detail-section" aria-labelledby="description-heading">
        <h2 id="description-heading">Description</h2>
        <p className="detail-description">{graphic.description || 'A published OGraf package.'}</p>
      </section>

      {item && <>
        <section className="detail-section" aria-labelledby="creator-heading">
          <h2 id="creator-heading">Creator</h2>
          {author ? <ul className="creator-list">
            {author.name && <li><User size={16} />{author.name}</li>}
            {author.email && <li><Mail size={16} /><a href={`mailto:${author.email}`}>{author.email}</a></li>}
            {author.url && <li><ExternalLink size={16} /><a href={author.url} target="_blank" rel="noopener noreferrer">{author.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a></li>}
          </ul> : <p className="muted">The creator did not provide contact information.</p>}
        </section>

        <section className="detail-section" aria-labelledby="actions-heading">
          <h2 id="actions-heading">Available actions</h2>
          <ul className="action-list">
            {item.actions.map((action) => {
              const info = standardActions[action.type];
              const Icon = info.icon;
              const description = action.type === 'playAction' && item.stepCount > 1 ? `Animates the graphic in and advances through ${item.stepCount} steps.` : info.description;
              return <li key={action.type}><Icon size={18} /><div><strong>{info.name}</strong><span>{description}</span></div>{formatDuration(action.duration) && <em>{formatDuration(action.duration)}</em>}</li>;
            })}
            {item.customActions.map((action) => <li key={action.id}><Zap size={18} /><div>
              <strong>{action.name}</strong>
              <span>{action.description ?? 'Custom action.'}{action.hasParameters ? ' Accepts parameters.' : ''}</span>
            </div>{formatDuration(action.duration) && <em>{formatDuration(action.duration)}</em>}</li>)}
          </ul>
        </section>

        <section className="detail-section" aria-labelledby="technical-heading">
          <h2 id="technical-heading">Technical details</h2>
          <dl className="detail-facts detail-facts-grid">
            <div><dt>Rendering</dt><dd>{[item.supportsRealTime && 'Real-time', item.supportsNonRealTime && 'Non-real-time'].filter(Boolean).join(', ') || 'Not specified'}</dd></div>
            <div><dt>Steps</dt><dd>{item.stepCount ?? 1}</dd></div>
            <div><dt>Requirements</dt><dd>{item.renderRequirements.length ? item.renderRequirements.map(formatRequirement).join('; ') : 'None'}</dd></div>
            {item.manifestVersion && <div><dt>Manifest version</dt><dd>{item.manifestVersion}</dd></div>}
          </dl>
        </section>

        {item.properties.length > 0 && <section className="detail-section" aria-labelledby="properties-heading">
          <h2 id="properties-heading">Properties</h2>
          <ul className="property-list">
            {item.properties.map((property) => <li key={property.key}>
              <strong>{property.title}</strong>{property.type && <span className="mono">{property.type}</span>}
              {property.description && <p>{property.description}</p>}
            </li>)}
          </ul>
        </section>}
      </>}
    </article>
  );
}
