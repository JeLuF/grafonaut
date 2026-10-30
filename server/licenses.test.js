import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { findLicense, maxLicenseBytes, readLicense } from './licenses.js';

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-license-'));
after(() => fs.rm(storageRoot, { recursive: true, force: true }));
let archives = 0;

// An unpacked package with the given files; returns the version of the graphic whose manifest is at `manifestFile`.
async function makePackage(files, manifestFile = 'graphic.ograf.json') {
  const archiveId = `00000000-0000-4000-8000-${String(++archives).padStart(12, '0')}`;
  const root = path.join(storageRoot, 'archives', archiveId, 'extracted');
  for (const [name, content] of Object.entries({ [manifestFile]: '{}', ...files })) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return { archiveId, manifestFile, manifest: {}, mainFile: 'graphic.mjs' };
}

test('the license next to the manifest is found: LICENSE, LICENSE.md or LICENSE.txt, any case', async () => {
  assert.equal((await findLicense(await makePackage({ LICENSE: 'MIT' }), storageRoot)).name, 'LICENSE');
  assert.equal((await findLicense(await makePackage({ 'License.md': '# MIT' }), storageRoot)).name, 'License.md');
  assert.equal((await findLicense(await makePackage({ 'license.TXT': 'MIT' }), storageRoot)).name, 'license.TXT');
  assert.equal(await findLicense(await makePackage({ 'LICENSE.pdf': 'x', 'COPYING': 'x' }), storageRoot), null);
  assert.equal(await findLicense({ archiveId: 'not-a-uuid', manifestFile: 'x.json' }, storageRoot), null);
});

test('a graphic in a subfolder uses its own license first, then the package\'s', async () => {
  const shared = await makePackage({ LICENSE: 'package license', 'lower/other.txt': 'x' }, 'lower/graphic.ograf.json');
  assert.deepEqual(await readLicense(shared, storageRoot), { name: 'LICENSE', text: 'package license', truncated: false });
  const own = await makePackage({ LICENSE: 'package license', 'lower/LICENSE.md': 'graphic license' }, 'lower/graphic.ograf.json');
  assert.equal((await readLicense(own, storageRoot)).text, 'graphic license');
});

test('long licenses are cut, links out of the package are ignored', async () => {
  const long = await readLicense(await makePackage({ LICENSE: 'x'.repeat(maxLicenseBytes + 10) }), storageRoot);
  assert.equal(long.text.length, maxLicenseBytes);
  assert.equal(long.truncated, true);
  const outside = path.join(storageRoot, 'secret.txt');
  await fs.writeFile(outside, 'secret');
  const linked = await makePackage({});
  await fs.symlink(outside, path.join(storageRoot, 'archives', linked.archiveId, 'extracted', 'LICENSE'));
  assert.equal(await findLicense(linked, storageRoot), null);
});
