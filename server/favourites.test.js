import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { createFavourites } from './favourites.js';

const visible = '11111111-1111-4111-8111-111111111111';
const packageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let favourites;
let full;
const store = {
  listFavourites: async (accountId) => favourites.filter((favourite) => favourite.accountId === accountId).map(({ packageId: id }) => ({ packageId: id })),
  addFavourite: async (accountId, versionId) => {
    if (full) throw Object.assign(new Error('You can have at most 500 favourites'), { code: 'FAVOURITES_FULL' });
    if (versionId !== visible) return null;
    if (!favourites.some((favourite) => favourite.accountId === accountId && favourite.packageId === packageId)) favourites.push({ accountId, packageId });
    return packageId;
  },
  removeFavourite: async (accountId, id) => {
    const before = favourites.length;
    favourites = favourites.filter((favourite) => !(favourite.accountId === accountId && favourite.packageId === id));
    return favourites.length < before;
  }
};
const app = express();
app.use(express.json());
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: request.headers['x-account'] } : null; next(); });
app.use('/api/favourites', createFavourites({ store }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/favourites`;
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { favourites = []; full = false; });
const call = async (method, path = '', body, account = '7') => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(account ? { 'x-account': account } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test('favourites are added by version, listed per account and removed by package', async () => {
  assert.deepEqual(await call('POST', '', { versionId: visible }), { status: 201, body: { packageId } });
  assert.equal((await call('POST', '', { versionId: visible })).status, 201);
  assert.deepEqual((await call('GET')).body.items, [{ packageId }]);
  assert.deepEqual((await call('GET', '', undefined, '8')).body.items, []);
  assert.equal((await call('DELETE', `/${packageId}`, undefined, '8')).status, 404);
  assert.equal((await call('DELETE', `/${packageId}`)).status, 200);
  assert.deepEqual((await call('GET')).body.items, []);
});

test('invalid, unavailable and excess favourites are refused', async () => {
  assert.equal((await call('POST', '', { versionId: 'nope' })).status, 400);
  assert.equal((await call('POST', '', { versionId: '22222222-2222-4222-8222-222222222222' })).status, 404);
  assert.equal((await call('DELETE', '/not-a-package')).status, 404);
  full = true;
  assert.deepEqual(await call('POST', '', { versionId: visible }), { status: 409, body: { error: 'You can have at most 500 favourites' } });
  assert.equal((await call('GET', '', undefined, null)).status, 401);
});
