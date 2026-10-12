import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, mock, test } from 'node:test';

let accounts;
let queries;
mock.module('mysql2/promise', { defaultExport: {
  createPool: () => ({ query: async (sql, parameters) => {
    queries.push({ sql, parameters });
    return [accounts.get(parameters[0]) ? [accounts.get(parameters[0])] : []];
  } })
} });
mock.module('./storage.js', { namedExports: { storageRoot: '/unused' } });
const { hashToken, generateToken } = await import('./tokens.js');
const { default: router, apiMountPath, apiUrl } = await import('./ograf-api.js');
const app = express();
app.use(apiMountPath, router);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((resolve) => server.close(resolve)));
const token = generateToken();
beforeEach(() => { queries = []; accounts = new Map([[hashToken(token), { id: 7, twitch_login: 'host', twitch_display_name: 'Host' }]]); });

test('the entry point returns server information for a valid API token', async () => {
  const response = await fetch(`${base}/${token}/ograf/v1/`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, 'OGraf Platform');
  assert.equal(body.description, 'OGraf Server API for Host');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(queries[0].sql, /FROM api_tokens t/);
  assert.equal((await fetch(`${base}/${token}/ograf/v1`)).status, 200);
});

test('unknown or malformed tokens get a problem response without a lookup for malformed ones', async () => {
  const unknown = await fetch(`${base}/${generateToken()}/ograf/v1/`);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { title: 'Unauthorized', status: 401, detail: 'Unknown or replaced API token.', instance: '/' });
  queries = [];
  assert.equal((await fetch(`${base}/not-a-token/ograf/v1/graphics`)).status, 401);
  assert.equal(queries.length, 0);
});

test('CORS preflights succeed and endpoints that do not exist yet answer 501', async () => {
  const preflight = await fetch(`${base}/${token}/ograf/v1/renderers/r1/target/graphicInstance/playAction`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  const pending = await fetch(`${base}/${token}/ograf/v1/graphics`);
  assert.equal(pending.status, 501);
  assert.equal((await pending.json()).instance, '/graphics');
});

test('the API URL uses the main page host and the token path scope', () => {
  assert.equal(apiUrl({ protocol: 'https', host: 'app.example.com' }, token), `https://app.example.com/${token}/ograf/v1/`);
});
