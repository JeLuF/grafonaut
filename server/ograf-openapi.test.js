import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, test } from 'node:test';
import { createApiDocs } from './api-docs.js';
import { createOgrafApi } from './ograf-api.js';
import { ografOpenApi } from './ograf-openapi.js';

const document = ografOpenApi();

test('the documentation covers exactly the routes the API implements', () => {
  const router = createOgrafApi({ hub: {}, store: {}, findAccountByToken: async () => null });
  const implemented = router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods)
    .map((method) => `${method.toUpperCase()} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`));
  const documented = Object.entries(document.paths).flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`));
  assert.deepEqual([...documented].sort(), [...implemented].sort());
});

test('every schema reference resolves and every path parameter is declared', () => {
  const missing = [];
  JSON.stringify(document, (key, value) => {
    if (key === '$ref' && !document.components.schemas[value.replace('#/components/schemas/', '')]) missing.push(value);
    return value;
  });
  assert.deepEqual(missing, []);
  for (const [path, operations] of Object.entries(document.paths)) {
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const operation of Object.values(operations)) {
      assert.deepEqual(names.filter((name) => !operation.parameters?.some((parameter) => parameter.in === 'path' && parameter.name === name)), [], path);
    }
  }
});

const app = express();
app.use((request, _response, next) => { request.session = request.headers['x-account'] ? { accountId: 7 } : null; next(); });
app.use('/api-docs', createApiDocs({ apiUrlFor: async (request) => request.session ? 'https://app.example.com/TOKEN/ograf/v1/' : undefined }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api-docs`;
after(() => new Promise((resolve) => server.close(resolve)));

test('signed-in users get their own API URL as the server; others get a template', async () => {
  const own = await (await fetch(`${base}/openapi.json`, { headers: { 'x-account': '1' } })).json();
  assert.deepEqual(own.servers, [{ url: 'https://app.example.com/TOKEN/ograf/v1', description: 'Your account' }]);
  const response = await fetch(`${base}/openapi.json`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const anonymous = await response.json();
  assert.equal(anonymous.servers[0].url, '{origin}/{apiToken}/ograf/v1');
});

test('the documentation page loads Swagger UI from the app under a strict CSP', async () => {
  const page = await fetch(`${base}/`);
  const html = await page.text();
  const nonce = page.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
  assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">window.ui = SwaggerUIBundle`));
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  for (const asset of ['swagger-ui-bundle.js', 'swagger-ui.css']) {
    assert.ok(html.includes(`/api-docs/assets/${asset}`));
    assert.equal((await fetch(`${base}/assets/${asset}`)).status, 200);
  }
});
