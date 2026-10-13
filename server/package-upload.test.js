import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ingestUpload, uploadLimits, UploadError } from './package-upload.js';
import { graphicFiles, makeZip, manifest } from './zip-fixtures.js';

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-upload-'));
after(() => fs.rm(storageRoot, { recursive: true, force: true }));
const limits = uploadLimits({});
const archives = () => fs.readdir(path.join(storageRoot, 'archives')).catch(() => []);
// Runs an upload; `persist` records what it was given (and the unpacked files at that moment) and saves everything.
async function ingest(buffer, overrides = {}, decide = () => true) {
  const saved = [];
  let upload;
  const result = await ingestUpload(buffer, { storageRoot, limits: { ...limits, ...overrides }, persist: async (given) => {
    upload = { ...given, files: await fs.readdir(path.join(storageRoot, 'archives', given.archiveId, 'extracted'), { recursive: true }) };
    saved.push(...given.graphics.filter(decide));
    return { saved: given.graphics.filter(decide).map((graphic) => ({ versionId: graphic.manifest.id })), skipped: [] };
  } });
  return { result, saved, upload };
}
async function rejects(buffer, pattern, overrides) {
  let error;
  try { await ingest(buffer, overrides); } catch (failure) { error = failure; }
  assert.ok(error instanceof UploadError, `expected an UploadError, got ${error}`);
  assert.match([error.message, ...error.details].join('\n'), pattern);
  assert.deepEqual(await fs.readdir(path.join(storageRoot, 'staging')), [], 'staging must be cleaned up');
  return error;
}

test('a valid package is validated, unpacked and handed over with its checksum', async () => {
  const zip = makeZip(graphicFiles());
  const { result, saved, upload } = await ingest(zip);
  assert.deepEqual(result, { saved: [{ versionId: 'lower-third' }], skipped: [] });
  assert.equal(upload.fileCount, 3);
  assert.equal(upload.zipSize, zip.length);
  assert.deepEqual(upload.files.sort(), ['graphic.mjs', 'lower-third.ograf.json', 'style.css']);
  assert.ok((await fs.stat(path.join(storageRoot, 'archives', upload.archiveId, 'package.ograf.zip'))).isFile());
  assert.equal(saved[0].manifest.id, 'lower-third');
  assert.equal(saved[0].mainFile, 'graphic.mjs');
  assert.equal(saved[0].manifestFile, 'lower-third.ograf.json');
  assert.equal(saved[0].checksum, crypto.createHash('sha256').update(zip).digest('hex'));
  assert.deepEqual(await fs.readdir(path.join(storageRoot, 'staging')), []);
});

test('every graphic of a multi-graphic package is saved with its own checksum', async () => {
  const { saved } = await ingest(makeZip([...graphicFiles('a/', 'left'), ...graphicFiles('b/', 'right')]));
  assert.deepEqual(saved.map((graphic) => [graphic.manifest.id, graphic.mainFile]), [['left', 'a/graphic.mjs'], ['right', 'b/graphic.mjs']]);
  assert.notEqual(saved[0].checksum, saved[1].checksum);
});

test('a package with many graphics is unpacked and stored only once', async () => {
  const before = (await archives()).length;
  const entries = [{ name: 'big.mp4', data: Buffer.alloc(1024 * 1024) }, { name: 'graphic.mjs', data: 'x' }];
  for (let i = 0; i < 200; i++) entries.push({ name: `g${i}.ograf.json`, data: manifest(`g${i}`) });
  const { saved, upload } = await ingest(makeZip(entries));
  assert.equal(saved.length, 200);
  assert.equal((await archives()).length, before + 1);
  const files = await fs.readdir(path.join(storageRoot, 'archives', upload.archiveId), { recursive: true, withFileTypes: true });
  const stored = (await Promise.all(files.filter((file) => file.isFile()).map((file) => fs.stat(path.join(file.parentPath, file.name)))))
    .reduce((total, stat) => total + stat.size, 0);
  assert.ok(stored < 3 * 1024 * 1024, `stored ${stored} bytes`);
});

test('the archive is removed again when no graphic is saved or saving fails', async () => {
  const before = await archives();
  await ingest(makeZip(graphicFiles('', 'skipped')), {}, () => false);
  assert.deepEqual(await archives(), before);
  await assert.rejects(ingestUpload(makeZip(graphicFiles('', 'failing')), { storageRoot, limits, persist: async () => { throw new Error('database down'); } }), /database down/);
  assert.deepEqual(await archives(), before);
  assert.deepEqual(await fs.readdir(path.join(storageRoot, 'staging')), []);
});

test('two graphics in one package cannot share a manifest id', async () => {
  await rejects(makeZip([...graphicFiles('a/', 'same'), ...graphicFiles('b/', 'same')]), /b\/same\.ograf\.json: another manifest in the package already uses the id same/);
});

test('unsafe names, symbolic links and disallowed file types are rejected before unpacking', async () => {
  await rejects(makeZip([...graphicFiles(), { name: '../escape.js', data: 'x' }]), /Unsafe path: \.\.\/escape\.js/);
  await rejects(makeZip([...graphicFiles(), { name: '/etc/cron.js', data: 'x' }]), /Unsafe path/);
  await rejects(makeZip([...graphicFiles(), { name: 'dir\\file.js', data: 'x' }]), /Unsafe path/);
  await rejects(makeZip([...graphicFiles(), { name: 'link.js', data: '/etc/passwd', mode: 0o120777 }]), /Symbolic links are not allowed: link\.js/);
  await rejects(makeZip([...graphicFiles(), { name: 'tool.exe', data: 'x' }]), /File type not allowed: tool\.exe/);
  await rejects(makeZip(graphicFiles()), /File type not allowed: style\.css/, { allowedExtensions: new Set(['.json', '.mjs']) });
});

test('entry count, archive size and the real unpacked size are limited', async () => {
  await rejects(makeZip(graphicFiles()), /3 entries; at most 2/, { maxFiles: 2 });
  const big = makeZip([...graphicFiles(), { name: 'video.mp4', data: Buffer.alloc(4000) }]);
  await rejects(big, /larger than 2000 bytes when unpacked/, { maxUncompressedBytes: 2000 });
  // A header that understates the size is caught while unpacking.
  await rejects(makeZip([...graphicFiles(), { name: 'video.mp4', data: Buffer.alloc(4000), declaredSize: 10 }]), /larger than 2000 bytes when unpacked/, { maxUncompressedBytes: 2000 });
  const error = await rejects(big, /larger than 100 bytes/, { maxZipBytes: 100 });
  assert.equal(error.status, 413);
});

test('manifests are validated against the OGraf schema and must point at an existing main module', async () => {
  await rejects(makeZip([{ name: 'graphic.mjs', data: 'x' }]), /No OGraf manifest/);
  await rejects(makeZip([{ name: 'a.ograf.json', data: '{nope' }, { name: 'graphic.mjs', data: 'x' }]), /a\.ograf\.json: not valid JSON/);
  await rejects(makeZip([{ name: 'a.ograf.json', data: JSON.stringify({ id: 'a', name: 'A', main: 'graphic.mjs' }) }, { name: 'graphic.mjs', data: 'x' }]),
    /a\.ograf\.json: \(manifest\) must have required property 'supportsRealTime'/);
  await rejects(makeZip([{ name: 'a.ograf.json', data: manifest('a', { main: 'missing.mjs' }) }]), /main file missing\.mjs is missing/);
  await rejects(makeZip([{ name: 'a.ograf.json', data: manifest('a', { main: 'style.css' }) }, { name: 'style.css', data: 'x' }]), /main must be a \.mjs or \.js file/);
  await rejects(makeZip([{ name: 'sub/a.ograf.json', data: manifest('a', { main: '../../outside.mjs' }) }, { name: 'graphic.mjs', data: 'x' }]), /main must be a \.mjs or \.js file inside the package/);
  await rejects(Buffer.from('not a zip at all'), /not a valid zip archive/);
});

test('one invalid graphic rejects the whole package', async () => {
  let persisted = 0;
  const zip = makeZip([...graphicFiles('a/', 'good'), { name: 'b/bad.ograf.json', data: manifest('bad', { main: 'none.mjs' }) }]);
  const before = await archives();
  await assert.rejects(ingestUpload(zip, { storageRoot, limits, persist: async () => { persisted += 1; return { saved: [], skipped: [] }; } }), /not a valid OGraf package/);
  assert.equal(persisted, 0);
  assert.deepEqual(await archives(), before);
});

test('upload limits come from the environment with the documented defaults', () => {
  const defaults = uploadLimits({});
  assert.equal(defaults.maxZipBytes, 10 * 1024 * 1024);
  assert.equal(defaults.maxUncompressedBytes, 50 * 1024 * 1024);
  assert.equal(defaults.maxFiles, 5000);
  for (const extension of ['.json', '.mjs', '.css', '.woff2', '.html']) assert.ok(defaults.allowedExtensions.has(extension), extension);
  const strict = uploadLimits({ UPLOAD_ALLOWED_EXTENSIONS: 'json, .MJS,png', UPLOAD_MAX_FILES: '10', UPLOAD_MAX_ZIP_BYTES: 'junk' });
  assert.deepEqual([...strict.allowedExtensions], ['.json', '.mjs', '.png']);
  assert.equal(strict.maxFiles, 10);
  assert.equal(strict.maxZipBytes, 10 * 1024 * 1024);
});
