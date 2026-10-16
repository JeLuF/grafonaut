import express from 'express';
import * as db from './db.js';

// Favourites: graphics (packages) an account bookmarked from the public or its private catalog. Added by any version ID
// the account can see; removed by package ID.
const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createFavourites({ store = db } = {}) {
  const router = express.Router();
  router.use((request, response, next) => {
    if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
    next();
  });

  router.get('/', async (request, response) => {
    try { response.set('Cache-Control', 'private, no-store').json({ items: await store.listFavourites(request.session.accountId) }); }
    catch { response.status(503).json({ error: 'Favourites unavailable' }); }
  });
  router.post('/', async (request, response) => {
    const versionId = request.body?.versionId;
    if (typeof versionId !== 'string' || !versionPattern.test(versionId)) return response.status(400).json({ error: 'A valid versionId is required' });
    try {
      const packageId = await store.addFavourite(request.session.accountId, versionId);
      if (!packageId) return response.status(404).json({ error: 'Graphic not found' });
      response.status(201).json({ packageId });
    } catch (error) {
      if (error.code === 'FAVOURITES_FULL') return response.status(409).json({ error: error.message });
      response.status(503).json({ error: 'Unable to add the favourite' });
    }
  });
  router.delete('/:packageId', async (request, response) => {
    if (!versionPattern.test(request.params.packageId)) return response.status(404).json({ error: 'Favourite not found' });
    try {
      if (!await store.removeFavourite(request.session.accountId, request.params.packageId)) return response.status(404).json({ error: 'Favourite not found' });
      response.json({ ok: true });
    } catch { response.status(503).json({ error: 'Unable to remove the favourite' }); }
  });
  return router;
}
