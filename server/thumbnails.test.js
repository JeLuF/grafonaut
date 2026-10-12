import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { findThumbnail, findThumbnails } from './thumbnails.js';

let rows = [];
let queries = [];
mock.module('mysql2/promise', { defaultExport: {
  createPool: () => ({ query: async (sql, parameters) => {
    queries.push({ sql, parameters });
    return [rows];
  } })
} });
const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-thumbnails-'));
mock.module('./storage.js', { namedExports: { storageRoot } });
const { catalogDetails, findPublishedCatalogItem, listPublishedCatalog, findPublishedVersion } = await import('./db.js');
const packageId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const root = path.join(storageRoot, 'packages', packageId, versionId, 'extracted');
let version;

beforeEach(async () => {
  rows = [];
  queries = [];
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'theme/thumbnails'), { recursive: true });
  version = { packageId, versionId, mainFile: 'theme/main.mjs', manifestFile: 'theme/manifest.json',
    manifest: { id: 'theme', main: 'main.mjs', thumbnails: [
      { file: 'thumbnails/1920x1080.png', resolution: { width: 1920, height: 1080 } },
      { file: 'thumbnails/animated.webp', resolution: { width: 640, height: 360 } }
    ] } };
  await fs.writeFile(path.join(root, 'theme/manifest.json'), JSON.stringify(version.manifest));
  await fs.writeFile(path.join(root, 'theme/thumbnails/1920x1080.png'), 'image');
  await fs.writeFile(path.join(root, 'theme/thumbnails/animated.webp'), 'image');
});
after(() => fs.rm(storageRoot, { recursive: true, force: true }));

test('resolves the first thumbnail relative to a nested manifest', async () => {
  assert.equal(await findThumbnail(version, storageRoot), await fs.realpath(path.join(root, 'theme/thumbnails/1920x1080.png')));
});
test('falls back to the next thumbnail when the first file is missing', async () => {
  await fs.rm(path.join(root, 'theme/thumbnails/1920x1080.png'));
  assert.equal(await findThumbnail(version, storageRoot), await fs.realpath(path.join(root, 'theme/thumbnails/animated.webp')));
});
test('recovers manifest locations for previously imported animations', async () => {
  delete version.manifestFile;
  assert.ok((await findThumbnail(version, storageRoot)).endsWith('1920x1080.png'));
});
test('returns no thumbnail for missing or malformed declarations', async () => {
  for (const thumbnails of [undefined, null, {}, [], [null, { file: 42 }, { file: 'main.mjs' }]]) {
    version.manifest.thumbnails = thumbnails;
    assert.equal(await findThumbnail(version, storageRoot), null);
  }
});
test('rejects traversal, absolute paths and unsupported files', async () => {
  for (const file of ['../../outside.png', '/outside.png', 'C:/outside.png', '..\\outside.png', 'https://example.com/image.png', 'main.mjs']) {
    version.manifest.thumbnails = [{ file }];
    assert.equal(await findThumbnail(version, storageRoot), null);
  }
  version.packageId = '../outside';
  assert.equal(await findThumbnail(version, storageRoot), null);
});
test('returns no thumbnail when extracted storage is missing', async () => {
  await fs.rm(root, { recursive: true, force: true });
  assert.equal(await findThumbnail(version, storageRoot), null);
});

test('catalog exposes optional thumbnail URLs without exposing manifest internals', async () => {
  rows = [{ ...version, display_name: 'Theme', versionLabel: '1.0.0' }];
  const items = await listPublishedCatalog();
  assert.equal(items[0].thumbnailUrl, `/api/catalog/${versionId}/thumbnail`);
  assert.equal(items[0].display_name, 'Theme');
  assert.equal('manifest' in items[0], false);
  assert.equal('manifestFile' in items[0], false);
  assert.equal('mainFile' in items[0], false);
  assert.match(queries[0].sql, /pv.review_state = 'published' AND p.disabled = FALSE/);
  rows[0].manifest = { ...version.manifest, thumbnails: [] };
  assert.equal((await listPublishedCatalog())[0].thumbnailUrl, null);
});

test('thumbnail lookup only queries published versions of enabled packages', async () => {
  rows = [version];
  assert.deepEqual(await findPublishedVersion(versionId), version);
  assert.deepEqual(queries[0].parameters, [versionId]);
  assert.match(queries[0].sql, /pv.id = \? AND pv.review_state = 'published' AND p.disabled = FALSE/);
  rows = [];
  assert.equal(await findPublishedVersion(versionId), null);
});
test('lists every available thumbnail with its manifest index', async () => {
  version.manifest.thumbnails.splice(1, 0, { file: '../escape.png' }, { file: 'thumbnails/missing.png' });
  const found = await findThumbnails(version, storageRoot);
  assert.deepEqual(found.map(({ index }) => index), [0, 3]);
  assert.ok(found[1].file.endsWith('animated.webp'));
});

test('catalog detail exposes all thumbnails and sanitized manifest metadata', async () => {
  rows = [{ ...version, display_name: 'Theme', versionLabel: '1.0.0', source: 'seed_builtin', manifestId: 'theme',
    manifest: { ...version.manifest, author: { name: 'Studio', url: 'studio.example' }, stepCount: 2,
      customActions: [{ id: 'flash', name: 'Flash', schema: { type: 'object' } }, { name: 'no id' }],
      actionDurations: [{ type: 'playAction', duration: 800 }, { type: 'customAction', customActionId: 'flash', duration: 100 }],
      schema: { type: 'object', properties: { title: { type: 'string', title: 'Title' }, secret: { type: 'string', hidden: true } } } } }];
  const item = await findPublishedCatalogItem(versionId);
  assert.deepEqual(queries[0].parameters, [versionId]);
  assert.match(queries[0].sql, /pv.review_state = 'published' AND p.disabled = FALSE/);
  assert.deepEqual(item.thumbnails.map((thumbnail) => thumbnail.url), [`/api/catalog/${versionId}/thumbnails/0`, `/api/catalog/${versionId}/thumbnails/1`]);
  assert.deepEqual(item.thumbnails[0], { url: `/api/catalog/${versionId}/thumbnails/0`, width: 1920, height: 1080, animated: false });
  assert.deepEqual(item.author, { name: 'Studio', email: null, url: 'https://studio.example/' });
  assert.deepEqual(item.actions[0], { type: 'playAction', duration: 800 });
  assert.deepEqual(item.customActions, [{ id: 'flash', name: 'Flash', description: null, hasParameters: true, duration: 100 }]);
  assert.deepEqual(item.properties, [{ key: 'title', title: 'Title', type: 'string', description: null }]);
  for (const key of ['manifest', 'manifestFile', 'mainFile']) assert.equal(key in item, false);
  rows = [];
  assert.equal(await findPublishedCatalogItem(versionId), null);
});

test('manifest metadata rejects unsafe or malformed author links', () => {
  assert.equal(catalogDetails({ author: { name: 'X', url: 'javascript:alert(1)' } }).author.url, null);
  assert.equal(catalogDetails({ author: { email: 'not an email' } }).author, null);
  assert.equal(catalogDetails({ author: 'Plain Name' }).author.name, 'Plain Name');
  const empty = catalogDetails(null);
  assert.equal(empty.author, null);
  assert.deepEqual(empty.customActions, []);
  assert.deepEqual(empty.renderRequirements, []);
  assert.deepEqual(catalogDetails({ renderRequirements: [{ resolution: { width: { min: 600, ideal: 1920, bogus: 'x' } }, frameRate: 50 }] }).renderRequirements,
    [{ width: { ideal: 1920, min: 600 }, height: null, frameRate: { exact: 50 } }]);
});
