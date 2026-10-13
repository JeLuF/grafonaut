import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { uploadLimits } from './package-upload.js';
import { createPrivateCatalog } from './private-catalog.js';
import { graphicFiles, makeZip, manifest } from './zip-fixtures.js';

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-private-'));
let packages;
let versions;
const store = {
  findOwnedUpload: async (accountId, checksum) => versions.find((version) => version.accountId === accountId && version.checksum === checksum) ?? null,
  findOwnedPackageId: async (accountId, manifestId) => packages.find((pkg) => pkg.accountId === accountId && pkg.manifestId === manifestId)?.id ?? null,
  saveUploadedVersions: async (accountId, saved) => {
    for (const version of saved) {
      if (version.isNewPackage) packages.push({ id: version.packageId, accountId, manifestId: version.manifestId });
      versions.push({ ...version, versionId: version.id, name: version.manifestName, accountId });
    }
  },
  listPrivateCatalog: async (accountId) => versions.filter((version) => version.accountId === accountId).map((version) => ({ versionId: version.id }))
};
const app = express();
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: request.headers['x-account'] } : null; next(); });
app.use('/api/private', createPrivateCatalog({ storageRoot, store, limits: { ...uploadLimits({}), maxZipBytes: 50000 } }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/private`;
after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(storageRoot, { recursive: true, force: true }); });
beforeEach(() => { packages = []; versions = []; });

const upload = async (body, account = '7') => {
  const response = await fetch(`${base}/packages`, { method: 'POST', headers: { 'Content-Type': 'application/zip', ...(account ? { 'x-account': account } : {}) }, body });
  return { status: response.status, body: await response.json() };
};

test('an upload stores the archive and files under a new private package version', async () => {
  const response = await upload(makeZip(graphicFiles()));
  assert.equal(response.status, 201);
  const [saved] = response.body.saved;
  assert.deepEqual([saved.name, saved.versionLabel, saved.newPackage], ['Graphic lower-third', '1.2.0', true]);
  const directory = path.join(storageRoot, 'archives', versions[0].archiveId);
  assert.deepEqual((await fs.readdir(path.join(directory, 'extracted'))).sort(), ['graphic.mjs', 'lower-third.ograf.json', 'style.css']);
  assert.ok((await fs.stat(path.join(directory, 'package.ograf.zip'))).isFile());
  assert.equal(versions[0].mainFile, 'graphic.mjs');
  assert.equal(versions[0].manifest.id, 'lower-third');
  assert.deepEqual((await fs.readdir(path.join(storageRoot, 'staging'))), []);
});

test('uploading the same graphic id again adds a version; an identical file is skipped', async () => {
  const first = (await upload(makeZip(graphicFiles()))).body.saved[0];
  const changed = makeZip([{ name: 'lower-third.ograf.json', data: manifest('lower-third', { version: '1.3.0' }) }, { name: 'graphic.mjs', data: 'export default class extends HTMLElement { x() {} }' }]);
  const second = (await upload(changed)).body.saved[0];
  assert.equal(second.packageId, first.packageId);
  assert.equal(second.newPackage, false);
  assert.notEqual(second.versionId, first.versionId);
  const again = await upload(changed);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.saved, []);
  assert.equal(again.body.skipped[0].versionId, second.versionId);
  assert.equal(packages.length, 1);
  assert.equal((await upload(makeZip(graphicFiles()), '8')).body.saved[0].newPackage, true);
});

test('invalid uploads report every problem and save nothing', async () => {
  const archivesBefore = await fs.readdir(path.join(storageRoot, 'archives')).catch(() => []);
  const response = await upload(makeZip([...graphicFiles(), { name: 'run.exe', data: 'x' }, { name: '../up.js', data: 'x' }]));
  assert.equal(response.status, 422);
  assert.equal(response.body.error, 'The package contains files that are not allowed.');
  assert.deepEqual(response.body.details, ['File type not allowed: run.exe', 'Unsafe path: ../up.js']);
  assert.equal(versions.length, 0);
  assert.deepEqual(await fs.readdir(path.join(storageRoot, 'archives')).catch(() => []), archivesBefore);
});

test('size limit, empty bodies and sign-in are enforced', async () => {
  const tooBig = await upload(Buffer.alloc(60000));
  assert.equal(tooBig.status, 413);
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  assert.equal((await upload(makeZip(graphicFiles()), null)).status, 401);
  assert.equal((await fetch(`${base}/packages`)).status, 401);
});

test('the private catalog lists only the account’s own uploads', async () => {
  await upload(makeZip(graphicFiles()));
  await upload(makeZip(graphicFiles('', 'other')), '8');
  const list = await (await fetch(`${base}/packages`, { headers: { 'x-account': '7' } })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].versionId, versions.find((version) => version.accountId === '7').id);
});

test('all graphics of a multi-graphic upload share one stored archive and are saved together', async () => {
  const response = await upload(makeZip([...graphicFiles('a/', 'left'), ...graphicFiles('b/', 'right')]));
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.saved.map((graphic) => graphic.name), ['Graphic left', 'Graphic right']);
  assert.equal(new Set(versions.map((version) => version.archiveId)).size, 1);
  assert.deepEqual(versions.map((version) => version.mainFile), ['a/graphic.mjs', 'b/graphic.mjs']);
  assert.equal(packages.length, 2);
});
