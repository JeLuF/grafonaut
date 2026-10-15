import express from 'express';
import { addMyGraphic, deleteMyGraphic, duplicateMyGraphic, findMyGraphic, listMyGraphics, reorderMyGraphics, updateMyGraphic } from './db.js';
import { storageRoot } from './storage.js';
import { resolvePropertySchema } from './asset-files.js';
import { SchemaTimeoutError, untrustedSchemas } from './untrusted-schema.js';

const router = express.Router();

router.use((request, response, next) => {
  if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
  next();
});
// Lets connected renderers follow My Graphics: new order, removed or disabled entries.
const entriesChanged = (request) => request.app.locals.onEntriesChanged?.(request.session.accountId);
router.param('entryId', (request, response, next, entryId) => {
  if (!/^[1-9]\d{0,19}$/.test(entryId) || BigInt(entryId) > 18446744073709551615n) {
    return response.status(400).json({ error: 'Invalid entry ID' });
  }
  next();
});

router.get('/', async (request, response) => {
  try { response.json({ items: await listMyGraphics(request.session.accountId) }); }
  catch { response.status(503).json({ error: 'My Graphics unavailable' }); }
});
router.post('/', async (request, response) => {
  const versionId = request.body?.versionId;
  if (typeof versionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) {
    return response.status(400).json({ error: 'A valid versionId is required' });
  }
  try {
    const entryId = await addMyGraphic(request.session.accountId, versionId);
    entriesChanged(request);
    response.status(201).json({ entryId });
  } catch (error) {
    response.status(error.message === 'Available graphic version not found' ? 404 : 503)
      .json({ error: error.message === 'Available graphic version not found' ? error.message : 'Unable to add graphic' });
  }
});
router.put('/order', async (request, response) => {
  const entryIds = request.body?.entryIds;
  if (!Array.isArray(entryIds) || entryIds.some((entryId) => typeof entryId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(entryId) || BigInt(entryId) > 18446744073709551615n) || new Set(entryIds).size !== entryIds.length) {
    return response.status(400).json({ error: 'Provide a unique ordered array of entry IDs' });
  }
  try {
    await reorderMyGraphics(request.session.accountId, entryIds);
    entriesChanged(request);
    response.json({ ok: true });
  } catch (error) {
    response.status(error.code === 'STALE_GRAPHICS_ORDER' ? 409 : 503)
      .json({ error: error.code === 'STALE_GRAPHICS_ORDER' ? error.message : 'Unable to save graphic order' });
  }
});
router.patch('/:entryId', async (request, response) => {
  const changes = request.body;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length ||
    Object.keys(changes).some((key) => !['label', 'enabled', 'schemaData'].includes(key))) {
    return response.status(400).json({ error: 'Provide label, enabled or schemaData' });
  }
  if (Object.hasOwn(changes, 'label') && changes.label !== null &&
    (typeof changes.label !== 'string' || [...changes.label].length > 100)) {
    return response.status(400).json({ error: 'Label must be at most 100 characters' });
  }
  if (Object.hasOwn(changes, 'enabled') && typeof changes.enabled !== 'boolean') {
    return response.status(400).json({ error: 'Enabled must be a boolean' });
  }
  try {
    const entry = await findMyGraphic(request.session.accountId, request.params.entryId);
    if (!entry) return response.status(404).json({ error: 'Graphic entry not found' });
    if (entry.packageDisabled && changes.enabled === true) {
      return response.status(409).json({ error: 'This graphic package is disabled' });
    }
    if (Object.hasOwn(changes, 'schemaData')) {
      const schema = await resolvePropertySchema(entry, storageRoot);
      let check;
      try { check = await untrustedSchemas.run('validate', schema, changes.schemaData); }
      catch (error) {
        if (error instanceof SchemaTimeoutError) return response.status(422).json({ error: 'Checking the properties took too long: this graphic\'s property schema is too complex' });
        throw error;
      }
      if (check.invalidSchema) return response.status(422).json({ error: 'This graphic has an unsupported property schema' });
      if (!check.valid) return response.status(422).json({ error: 'Properties do not match this graphic\'s schema', details: check.errors });
    }
    await updateMyGraphic(request.session.accountId, request.params.entryId, changes);
    if (Object.hasOwn(changes, 'enabled')) entriesChanged(request);
    response.json({ ok: true });
  } catch { response.status(503).json({ error: 'Unable to save graphic entry' }); }
});
router.delete('/:entryId', async (request, response) => {
  try {
    if (!await deleteMyGraphic(request.session.accountId, request.params.entryId)) {
      return response.status(404).json({ error: 'Graphic entry not found' });
    }
    entriesChanged(request);
    response.json({ ok: true });
  } catch { response.status(503).json({ error: 'Unable to delete graphic entry' }); }
});
router.post('/:entryId/duplicate', async (request, response) => {
  try {
    const entryId = await duplicateMyGraphic(request.session.accountId, request.params.entryId);
    if (!entryId) return response.status(404).json({ error: 'Graphic entry not found' });
    entriesChanged(request);
    response.status(201).json({ entryId });
  } catch { response.status(503).json({ error: 'Unable to duplicate graphic entry' }); }
});
router.get('/:entryId/manifest', async (request, response) => {
  try {
    const entry = await findMyGraphic(request.session.accountId, request.params.entryId);
    if (!entry) return response.status(404).json({ error: 'Graphic entry not found' });
    response.set('Cache-Control', 'private, no-store').json({ manifest: entry.manifest });
  } catch { response.status(503).json({ error: 'Unable to load graphic manifest' }); }
});

export default router;