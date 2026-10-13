import crypto from 'node:crypto';
import express from 'express';
import * as db from './db.js';
import { ingestUpload, uploadLimits, UploadError } from './package-upload.js';
import { storageRoot as defaultStorageRoot } from './storage.js';

// Private catalog: .ograf.zip uploads of the signed-in account. Each graphic in an upload becomes a new private
// version; uploading a graphic with the same manifest id again adds a version to the existing package.
export function createPrivateCatalog({ limits = uploadLimits(), storageRoot = defaultStorageRoot, store = db } = {}) {
  const router = express.Router();
  const queues = new Map();
  // Uploads of one account run one after the other, so two uploads cannot both create the same package.
  function serialized(accountId, work) {
    const previous = queues.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(accountId, next);
    next.finally(() => { if (queues.get(accountId) === next) queues.delete(accountId); }).catch(() => {});
    return next;
  }

  // Turns the graphics of one validated upload into private versions that share the upload's unpacked files.
  // Identical re-uploads are skipped; a graphic whose manifest id already has a package becomes a new version of it.
  async function persist(accountId, upload) {
    const saved = [];
    const skipped = [];
    const versions = [];
    for (const graphic of upload.graphics) {
      const { manifest } = graphic;
      const versionLabel = String(manifest.version ?? '1.0.0');
      const existing = await store.findOwnedUpload(accountId, graphic.checksum);
      if (existing) { skipped.push({ versionId: existing.versionId, name: existing.name, versionLabel: existing.versionLabel }); continue; }
      const knownPackageId = await store.findOwnedPackageId(accountId, manifest.id);
      const version = {
        id: crypto.randomUUID(), packageId: knownPackageId ?? crypto.randomUUID(), isNewPackage: !knownPackageId,
        archiveId: upload.archiveId, manifestId: manifest.id, manifestName: manifest.name, versionLabel,
        description: manifest.description ?? null, manifest, manifestFile: graphic.manifestFile, mainFile: graphic.mainFile,
        checksum: graphic.checksum, zipSize: upload.zipSize, uncompressedSize: upload.uncompressedSize, fileCount: upload.fileCount
      };
      versions.push(version);
      saved.push({ versionId: version.id, packageId: version.packageId, name: manifest.name, versionLabel, newPackage: version.isNewPackage });
    }
    if (versions.length) await store.saveUploadedVersions(accountId, versions);
    return { saved, skipped };
  }

  router.use((request, response, next) => {
    if (!request.session?.accountId) return response.status(401).json({ error: 'Sign-in required' });
    next();
  });
  router.get('/packages', async (request, response) => {
    try { response.json({ items: await store.listPrivateCatalog(request.session.accountId), maxZipBytes: limits.maxZipBytes }); }
    catch { response.status(503).json({ error: 'Private catalog unavailable' }); }
  });
  router.post('/packages', express.raw({ type: () => true, limit: limits.maxZipBytes }), async (request, response) => {
    const accountId = request.session.accountId;
    if (!Buffer.isBuffer(request.body) || !request.body.length) return response.status(400).json({ error: 'Send the .ograf.zip file as the request body' });
    try {
      const result = await serialized(accountId, () => ingestUpload(request.body, { storageRoot, limits, persist: (upload) => persist(accountId, upload) }));
      response.status(result.saved.length ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof UploadError) return response.status(error.status).json({ error: error.message, details: error.details });
      console.error('Upload failed:', error);
      response.status(503).json({ error: 'The upload could not be saved' });
    }
  });
  router.use((error, _request, response, next) => {
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: `The file is larger than ${limits.maxZipBytes} bytes.`, details: [] });
    next(error);
  });
  return router;
}
