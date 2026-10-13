import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { applyFileLists, listAssetFiles, resolvePropertySchema } from './asset-files.js';

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-assets-'));
const packageId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const archiveId = '33333333-3333-4333-8333-333333333333';
const root = path.join(storageRoot, 'archives', archiveId, 'extracted');
const themeProperty = { type: 'string', title: 'Visual Theme', default: './resources/themes/Default.css',
  v_spx: { ftype: 'filelist', extension: 'css', assetfolder: './resources/themes/' } };
let version;

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'pkg/resources/themes/nested'), { recursive: true });
  for (const file of ['Default.css', 'Bank.CSS', 'News.css', 'notes.txt', '.hidden.css', 'nested/Deep.css']) {
    await fs.writeFile(path.join(root, 'pkg/resources/themes', file), '');
  }
  await fs.writeFile(path.join(root, 'outside.css'), '');
  version = { packageId, versionId, archiveId, mainFile: 'pkg/main.mjs', manifestFile: 'pkg/manifest.ograf.json',
    manifest: { id: 'info', main: 'main.mjs', schema: { type: 'object', properties: { f99: themeProperty, text: { type: 'string' } } } } };
});
after(() => fs.rm(storageRoot, { recursive: true, force: true }));

test('file list properties become a select of matching files relative to the manifest', async () => {
  const schema = await resolvePropertySchema(version, storageRoot);
  assert.deepEqual(schema.properties.f99.oneOf, [
    { const: './resources/themes/Bank.CSS', title: 'Bank.CSS' },
    { const: './resources/themes/Default.css', title: 'Default.css' },
    { const: './resources/themes/News.css', title: 'News.css' }
  ]);
  assert.equal(schema.properties.f99.title, 'Visual Theme');
  assert.deepEqual(schema.properties.text, { type: 'string' });
  assert.equal('oneOf' in version.manifest.schema.properties.f99, false);
});

test('the default stays selectable and folders without a trailing slash are joined correctly', async () => {
  const schema = await applyFileLists({ type: 'object', properties: {
    icon: { type: 'string', default: 'icons/missing.json', v_spx: { ftype: 'filelist', extension: '.json', assetfolder: 'icons' } }
  } }, async (folder, extensions) => {
    assert.deepEqual([folder, extensions], ['icons', ['json']]);
    return ['live.json'];
  });
  assert.deepEqual(schema.properties.icon.oneOf, [{ const: 'icons/missing.json', title: 'missing.json' }, { const: 'icons/live.json', title: 'live.json' }]);
});

test('file lists apply inside arrays and nested objects but leave explicit choices alone', async () => {
  const schema = await applyFileLists({ type: 'object', properties: {
    slides: { type: 'array', items: { type: 'object', properties: { image: { type: 'string', v_spx: { ftype: 'filelist', extension: 'png', assetfolder: 'img/' } } } } },
    fixed: { type: 'string', enum: ['a'], v_spx: { ftype: 'filelist', extension: 'png', assetfolder: 'img/' } },
    count: { type: 'number', v_spx: { ftype: 'filelist', extension: 'png', assetfolder: 'img/' } },
    empty: { type: 'string', v_spx: { ftype: 'filelist', extension: 'gif', assetfolder: 'img/' } }
  } }, async (_folder, extensions) => extensions[0] === 'png' ? ['a.png'] : []);
  assert.deepEqual(schema.properties.slides.items.properties.image.oneOf, [{ const: 'img/a.png', title: 'a.png' }]);
  assert.deepEqual(schema.properties.fixed.enum, ['a']);
  assert.equal('oneOf' in schema.properties.fixed, false);
  assert.equal('oneOf' in schema.properties.count, false);
  assert.equal('oneOf' in schema.properties.empty, false);
});

test('asset folders cannot escape the package', async () => {
  const manifestDirectory = path.join(root, 'pkg');
  assert.deepEqual(await listAssetFiles(root, manifestDirectory, '../..', ['css']), []);
  assert.deepEqual(await listAssetFiles(root, manifestDirectory, '../', ['css']), ['outside.css']);
  await fs.symlink(storageRoot, path.join(root, 'pkg/link'));
  assert.deepEqual(await listAssetFiles(root, manifestDirectory, './link', ['css']), []);
  assert.deepEqual(await listAssetFiles(root, manifestDirectory, './missing', ['css']), []);
  for (const assetfolder of ['/etc', 'C:/themes', '..\\themes']) {
    version.manifest.schema.properties.f99 = { ...themeProperty, v_spx: { ...themeProperty.v_spx, assetfolder } };
    const schema = await resolvePropertySchema(version, storageRoot);
    assert.equal('oneOf' in schema.properties.f99, false);
  }
});

test('missing storage keeps the default as the only choice', async () => {
  await fs.rm(root, { recursive: true, force: true });
  const schema = await resolvePropertySchema(version, storageRoot);
  assert.deepEqual(schema.properties.f99.oneOf, [{ const: './resources/themes/Default.css', title: 'Default.css' }]);
  assert.deepEqual(await resolvePropertySchema({ ...version, archiveId: '../x' }, storageRoot).then((result) => result.properties.f99.oneOf.length), 1);
});
