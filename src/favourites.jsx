import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { requestJson } from './api.js';

// The account's favourite graphics. Favourites are per package: a star on any version of a graphic marks the graphic,
// and the list shows the version the account sees (its own packages: the latest version).
export function useFavourites(account, { onError } = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const reload = useCallback(async () => {
    const requestId = ++request.current;
    if (!account) { setItems([]); setError(''); return; }
    setLoading(true);
    try {
      const response = await requestJson('/api/favourites');
      if (requestId === request.current) { setItems(response.items ?? []); setError(''); }
    } catch (failure) { if (requestId === request.current) setError(failure.message); }
    finally { if (requestId === request.current) setLoading(false); }
  }, [account]);
  useEffect(() => { void reload(); }, [reload]);

  const packageIds = new Set(items.map((item) => item.packageId));
  const has = (item) => Boolean(item?.packageId) && packageIds.has(item.packageId);
  async function toggle(item) {
    try {
      if (has(item)) {
        await requestJson(`/api/favourites/${encodeURIComponent(item.packageId)}`, { method: 'DELETE' });
        request.current += 1;
        setItems((current) => current.filter((favourite) => favourite.packageId !== item.packageId));
      } else {
        await requestJson('/api/favourites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versionId: item.versionId }) });
        await reload();
      }
    } catch (failure) { onError?.(failure); throw failure; }
  }
  return { items, loading, error, has, toggle, reload };
}

export function FavouriteButton({ item, favourites, disabled, label }) {
  const [busy, setBusy] = useState(false);
  if (!favourites || !item?.packageId) return null;
  const active = favourites.has(item);
  const text = active ? 'Remove from favourites' : 'Add to favourites';
  async function toggle() {
    setBusy(true);
    try { await favourites.toggle(item); } catch { /* reported through onError */ }
    finally { setBusy(false); }
  }
  return <button className={`favourite-button${active ? ' is-favourite' : ''}${label ? ' text-button' : ''}`} type="button" onClick={toggle}
    disabled={disabled || busy} aria-pressed={active} aria-label={label ? undefined : `${text}: ${item.display_name}`}
    title={disabled ? 'Sign in to keep favourites' : text}>
    <Star size={label ? 16 : 18} fill={active ? 'currentColor' : 'none'} />{label && (active ? 'Favourite' : 'Add to favourites')}
  </button>;
}
