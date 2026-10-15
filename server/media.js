import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import * as db from './db.js';
import { uploadLimits } from './package-upload.js';
import { assetTypes, graphicSandbox } from './renderer.js';
import { storageRoot as defaultStorageRoot } from './storage.js';

// Media library: files an account uploads for graphic properties (images, videos, ...). Graphics reference a file by
// its absolute URL on the graphics host (else the renderer host), /render/media/<id>.<extension>; the ID is a random UUID. Replacing a file
// keeps its URL, so every graphic using it shows the new content.
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const mediaFileRoute = '/render/media/:file';

export function mediaLimits(env = process.env) {
  const max = Number(env.MEDIA_MAX_BYTES);
  return { maxBytes: Number.isInteger(max) && max > 0 ? max : 20 * 1024 * 1024, allowedExtensions: uploadLimits(env).allowedExtensions };
}

function cleanName(value) {
  const name = path.basename(String(value ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return name && [...name].length <= 255 ? name : null;
}

// `fileOrigin(request)`: the origin media files are served from to graphics (the graphics host, if set).
export function createMedia({ store = db, storageRoot = defaultStorageRoot, limits = mediaLimits(), fileOrigin }) {
  const router = express.Router();
  const filePath = (accountId, media) => path.join(storageRoot, 'media', String(accountId), `${media.id}.${media.extension}`);
  const describe = (request, media) => ({ id: media.id, name: media.name, extension: media.extension, size: media.size,
    updatedAt: media.updatedAt, usage: media.usage ?? 0,
    url: `${fileOrigin(request)}/render/media/${media.id}.${media.extension}`,
    previewUrl: `/api/media/${media.id}/content?v=${media.checksum.slice(0, 12)}` });

  async function writeFile(target, buffer) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, buffer);
    await fs.rename(temporary, target);
  }
  const extensionOf = (name) => path.extname(name).slice(1).toLowerCase();
  const raw = express.raw({ type: () => true, limit: limits.maxBytes });

  router.use((request, response, next) => {
    if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
    next();
  });
  router.param('mediaId', (request, response, next, mediaId) => {
    if (!idPattern.test(mediaId)) return response.status(404).json({ error: 'File not found' });
    next();
  });

  router.get('/', async (request, response) => {
    try {
      const items = await store.listMedia(request.session.accountId);
      response.set('Cache-Control', 'private, no-store').json({ items: items.map((media) => describe(request, media)), maxBytes: limits.maxBytes,
        extensions: [...limits.allowedExtensions].map((extension) => extension.slice(1)) });
    } catch { response.status(503).json({ error: 'Media unavailable' }); }
  });

  // Upload: the file is the request body, its name the `name` query parameter.
  router.post('/', raw, async (request, response) => {
    const name = cleanName(request.query.name);
    if (!name) return response.status(400).json({ error: 'Give the file name as ?name=' });
    const extension = extensionOf(name);
    if (!limits.allowedExtensions.has(`.${extension}`) || !assetTypes[`.${extension}`]) return response.status(415).json({ error: `Files of type .${extension || '?'} are not allowed` });
    if (!Buffer.isBuffer(request.body) || !request.body.length) return response.status(400).json({ error: 'The file is empty' });
    const media = { id: crypto.randomUUID(), name, extension, size: request.body.length,
      checksum: crypto.createHash('sha256').update(request.body).digest('hex') };
    const target = filePath(request.session.accountId, media);
    try {
      await writeFile(target, request.body);
      await store.insertMedia(request.session.accountId, media);
      response.status(201).json({ item: describe(request, { ...media, usage: 0 }) });
    } catch {
      await fs.rm(target, { force: true });
      response.status(503).json({ error: 'The file could not be saved' });
    }
  });

  // Replace the content; the file keeps its ID and URL, so the extension must stay the same.
  router.put('/:mediaId/content', raw, async (request, response) => {
    try {
      const media = await store.findMedia(request.params.mediaId, request.session.accountId);
      if (!media) return response.status(404).json({ error: 'File not found' });
      const name = cleanName(request.query.name);
      if (name && extensionOf(name) !== media.extension) {
        return response.status(415).json({ error: `The replacement must be a .${media.extension} file; upload other types as a new file` });
      }
      if (!Buffer.isBuffer(request.body) || !request.body.length) return response.status(400).json({ error: 'The file is empty' });
      const changes = { size: request.body.length, checksum: crypto.createHash('sha256').update(request.body).digest('hex') };
      await writeFile(filePath(request.session.accountId, media), request.body);
      await store.updateMedia(request.session.accountId, media.id, changes);
      response.json({ item: describe(request, { ...media, ...changes }) });
    } catch { response.status(503).json({ error: 'The file could not be replaced' }); }
  });

  router.patch('/:mediaId', async (request, response) => {
    const name = cleanName(request.body?.name);
    if (!name) return response.status(400).json({ error: 'Name must be 1 to 255 characters' });
    try {
      const media = await store.findMedia(request.params.mediaId, request.session.accountId);
      if (!media) return response.status(404).json({ error: 'File not found' });
      await store.updateMedia(request.session.accountId, media.id, { name });
      response.json({ ok: true, name });
    } catch { response.status(503).json({ error: 'The file could not be renamed' }); }
  });

  router.delete('/:mediaId', async (request, response) => {
    try {
      const media = await store.findMedia(request.params.mediaId, request.session.accountId);
      if (!media || !await store.deleteMedia(request.session.accountId, media.id)) return response.status(404).json({ error: 'File not found' });
      await fs.rm(filePath(request.session.accountId, media), { force: true });
      response.json({ ok: true });
    } catch { response.status(503).json({ error: 'The file could not be deleted' }); }
  });

  // Preview for the owner in the app (thumbnails in the media catalog and the property dialog).
  router.get('/:mediaId/content', async (request, response) => {
    try {
      const media = await store.findMedia(request.params.mediaId, request.session.accountId);
      if (!media) return response.sendStatus(404);
      sendMedia(response, filePath(request.session.accountId, media), media, false, 'private, max-age=3600');
    } catch { response.sendStatus(503); }
  });

  router.use((error, _request, response, next) => {
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: `The file is larger than ${limits.maxBytes} bytes` });
    next(error);
  });
  return router;
}

function sendMedia(response, file, media, isolated, cacheControl) {
  response.sendFile(file, { headers: {
    'Content-Type': assetTypes[`.${media.extension}`] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `sandbox ${graphicSandbox(isolated)}`, 'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*', 'Referrer-Policy': 'strict-origin', 'Cache-Control': cacheControl
  } }, (error) => { if (error && !response.headersSent) response.sendStatus(error.statusCode ?? 500); });
}

// Serves media to graphics on the renderer host: /render/media/<id>.<extension>. Put the referer check in front.
export function createMediaFileHandler({ store = db, storageRoot = defaultStorageRoot, isolated }) {
  return async (request, response) => {
    try {
      const match = /^([0-9a-f-]{36})\.([a-z0-9]{1,16})$/.exec(String(request.params.file ?? ''));
      if (!match || !idPattern.test(match[1])) return response.sendStatus(404);
      const media = await store.findMedia(match[1]);
      if (!media || media.extension !== match[2]) return response.sendStatus(404);
      sendMedia(response, path.join(storageRoot, 'media', media.accountId, `${media.id}.${media.extension}`), media, isolated, 'public, max-age=60');
    } catch { if (!response.headersSent) response.sendStatus(503); }
  };
}
