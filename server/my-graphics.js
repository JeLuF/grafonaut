import express from 'express';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { addMyGraphic, deleteMyGraphic, findMyGraphic, listMyGraphics, updateMyGraphic } from './db.js';
import { storageRoot } from './storage.js';
import { findThumbnail } from './thumbnails.js';

const validator = new Ajv({ allErrors: true, strict: false });
addFormats(validator);
const router = express.Router();

router.use((request, response, next) => {
  if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
  next();
});
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
    response.status(201).json({ entryId });
  } catch (error) {
    response.status(error.message === 'Available graphic version not found' ? 404 : 503)
      .json({ error: error.message === 'Available graphic version not found' ? error.message : 'Unable to add graphic' });
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
      let valid;
      try { valid = validator.validate(entry.manifest?.schema ?? {}, changes.schemaData); }
      catch { return response.status(422).json({ error: 'This graphic has an unsupported property schema' }); }
      if (!valid) return response.status(422).json({ error: 'Properties do not match this graphic\'s schema', details: validator.errors });
    }
    await updateMyGraphic(request.session.accountId, request.params.entryId, changes);
    response.json({ ok: true });
  } catch { response.status(503).json({ error: 'Unable to save graphic entry' }); }
});
router.delete('/:entryId', async (request, response) => {
  try {
    if (!await deleteMyGraphic(request.session.accountId, request.params.entryId)) {
      return response.status(404).json({ error: 'Graphic entry not found' });
    }
    response.json({ ok: true });
  } catch { response.status(503).json({ error: 'Unable to delete graphic entry' }); }
});
router.get('/:entryId/manifest', async (request, response) => {
  try {
    const entry = await findMyGraphic(request.session.accountId, request.params.entryId);
    if (!entry) return response.status(404).json({ error: 'Graphic entry not found' });
    response.set('Cache-Control', 'private, no-store').json({ manifest: entry.manifest });
  } catch { response.status(503).json({ error: 'Unable to load graphic manifest' }); }
});
router.get('/:entryId/thumbnail', async (request, response) => {
  try {
    const entry = await findMyGraphic(request.session.accountId, request.params.entryId);
    const thumbnail = entry && !entry.packageDisabled ? await findThumbnail(entry, storageRoot) : null;
    if (!thumbnail) return response.sendStatus(404);
    response.sendFile(thumbnail, { headers: {
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'"
    } }, (error) => {
      if (error && !response.headersSent) response.sendStatus(error.statusCode ?? 500);
    });
  } catch { response.sendStatus(503); }
});

export default router;