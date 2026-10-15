import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { createMedia, createMediaFileHandler, mediaFileRoute } from './media.js';
import { createRefererCheck, parseHosts, refererMode } from './referer.js';

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ograf-media-'));
let rows;
const store = {
  listMedia: async (accountId) => rows.filter((row) => row.accountId === String(accountId)).map((row) => ({ ...row, usage: row.usage ?? 0 })),
  findMedia: async (id, accountId = null) => rows.find((row) => row.id === id && (accountId == null || row.accountId === String(accountId))) ?? null,
  insertMedia: async (accountId, media) => { rows.push({ ...media, accountId: String(accountId) }); },
  updateMedia: async (accountId, id, changes) => {
    const row = rows.find((candidate) => candidate.id === id && candidate.accountId === String(accountId));
    if (!row) return false;
    Object.assign(row, changes);
    return true;
  },
  deleteMedia: async (accountId, id) => {
    const before = rows.length;
    rows = rows.filter((row) => !(row.id === id && row.accountId === String(accountId)));
    return rows.length < before;
  }
};
const app = express();
app.use(express.json());
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: request.headers['x-account'] } : null; next(); });
app.use('/api/media', createMedia({ store, storageRoot, limits: { maxBytes: 2000, allowedExtensions: new Set(['.png', '.jpg', '.svg', '.html']) },
  fileOrigin: () => 'https://render.example.com' }));
app.get(mediaFileRoute, createRefererCheck({ hosts: ['render.example.com'], mode: 'lenient' }), createMediaFileHandler({ store, storageRoot, isolated: true }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(storageRoot, { recursive: true, force: true }); });
beforeEach(() => { rows = []; });

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const call = async (method, route, { body, account = '7', type = 'application/json', referer } = {}) => {
  const headers = { ...(account ? { 'x-account': account } : {}), ...(body !== undefined ? { 'Content-Type': type } : {}), ...(referer ? { Referer: referer } : {}) };
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
};
const upload = (name, body = png, account = '7') => call('POST', `/api/media?name=${encodeURIComponent(name)}`, { body, account, type: 'image/png' });

test('uploads are stored per account and listed with their renderer URL', async () => {
  const created = await upload('Logo Big.PNG');
  assert.equal(created.status, 201);
  const { item } = created.body;
  assert.equal(item.name, 'Logo Big.PNG');
  assert.equal(item.extension, 'png');
  assert.equal(item.url, `https://render.example.com/render/media/${item.id}.png`);
  assert.match(item.previewUrl, new RegExp(`^/api/media/${item.id}/content\\?v=`));
  assert.deepEqual(await fs.readFile(path.join(storageRoot, 'media', '7', `${item.id}.png`)), png);
  const list = await call('GET', '/api/media');
  assert.deepEqual(list.body.items.map((media) => media.id), [item.id]);
  assert.deepEqual(list.body.extensions.sort(), ['html', 'jpg', 'png', 'svg']);
  assert.equal((await call('GET', '/api/media', { account: '8' })).body.items.length, 0);
  assert.equal((await call('GET', '/api/media', { account: null })).status, 401);
});

test('uploads are limited to the allowed file types and size', async () => {
  assert.equal((await upload('tool.exe')).status, 415);
  assert.equal((await upload('noextension')).status, 415);
  assert.equal((await upload('big.png', Buffer.alloc(3000))).status, 413);
  assert.equal((await upload('empty.png', Buffer.alloc(0))).status, 400);
  assert.equal((await call('POST', '/api/media', { body: png, type: 'image/png' })).status, 400);
  const traversal = await upload('../../evil.png');
  assert.equal(traversal.body.item.name, 'evil.png');
  assert.equal(rows.length, 1);
});

test('files can be renamed, replaced (same URL, same type only) and deleted by their owner only', async () => {
  const { item } = (await upload('logo.png')).body;
  assert.equal((await call('PATCH', `/api/media/${item.id}`, { body: { name: 'Main logo.png' } })).status, 200);
  assert.equal(rows[0].name, 'Main logo.png');
  assert.equal((await call('PATCH', `/api/media/${item.id}`, { body: { name: 'x' }, account: '8' })).status, 404);
  const replacement = Buffer.concat([png, Buffer.from('more')]);
  const replaced = await call('PUT', `/api/media/${item.id}/content?name=new.png`, { body: replacement, type: 'image/png' });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.item.url, item.url);
  assert.notEqual(replaced.body.item.previewUrl, item.previewUrl);
  assert.deepEqual(await fs.readFile(path.join(storageRoot, 'media', '7', `${item.id}.png`)), replacement);
  assert.equal((await call('PUT', `/api/media/${item.id}/content?name=new.jpg`, { body: png, type: 'image/jpeg' })).status, 415);
  assert.equal((await call('PUT', `/api/media/${item.id}/content`, { body: png, type: 'image/png', account: '8' })).status, 404);
  const preview = await call('GET', `/api/media/${item.id}/content`);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal((await call('GET', `/api/media/${item.id}/content`, { account: '8' })).status, 404);
  assert.equal((await call('DELETE', `/api/media/${item.id}`, { account: '8' })).status, 404);
  assert.equal((await call('DELETE', `/api/media/${item.id}`)).status, 200);
  assert.equal(rows.length, 0);
  await assert.rejects(fs.access(path.join(storageRoot, 'media', '7', `${item.id}.png`)));
});

test('media files are served without a referer or with an own one, never to foreign sites', async () => {
  const { item } = (await upload('logo.png')).body;
  const file = `/render/media/${item.id}.png`;
  const served = await call('GET', file, { account: null, referer: 'https://render.example.com/' });
  assert.equal(served.status, 200);
  assert.deepEqual(served.body, png);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /^sandbox allow-scripts allow-same-origin$/);
  assert.equal((await call('GET', file, { account: null, referer: `${base}/render/abc/` })).status, 200);
  assert.equal((await call('GET', file, { account: null })).status, 200);
  assert.equal((await call('GET', file, { account: null, referer: 'https://hotlinker.example/page' })).status, 403);
  assert.equal((await call('GET', `/render/media/${item.id}.jpg`, { account: null, referer: 'https://render.example.com/' })).status, 404);
  assert.equal((await call('GET', '/render/media/not-an-id.png', { account: null, referer: 'https://render.example.com/' })).status, 404);
});

test('the referer check knows strict, lenient and off and parses host lists', async () => {
  assert.deepEqual(parseHosts('grafanaut.example.com, https://render.example.com:8443/'), ['grafanaut.example.com', 'render.example.com:8443']);
  assert.deepEqual(parseHosts(''), []);
  assert.equal(refererMode(undefined), 'strict');
  assert.equal(refererMode(' Lenient '), 'lenient');
  assert.throws(() => refererMode('maybe'), /ASSET_REFERER_CHECK/);
  const run = (mode, referer) => {
    let status = 'next';
    createRefererCheck({ hosts: ['grafanaut.example.com'], mode })({ host: 'render.example.com', get: () => referer },
      { sendStatus: (code) => { status = code; } }, () => {});
    return status;
  };
  assert.equal(run('strict', undefined), 403);
  assert.equal(run('lenient', undefined), 'next');
  assert.equal(run('lenient', 'https://evil.example/'), 403);
  assert.equal(run('strict', 'https://grafanaut.example.com/x'), 'next');
  assert.equal(run('strict', 'https://render.example.com/render/t/'), 'next');
  assert.equal(run('strict', 'not a url'), 403);
  assert.equal(run('off', 'https://evil.example/'), 'next');
});
