import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { propertyDefaults } from './property-defaults.js';
import { payloadProblems } from './render-control.js';
import { createHosts, parseHostSetting } from './hosts.js';
import { rendererDocument } from './renderer.js';
import { sameOriginWrites } from './request-guards.js';
import { sessionSecret } from './session.js';
import { createSchemaRunner, SchemaTimeoutError, untrustedSchemas } from './untrusted-schema.js';

const runner = createSchemaRunner({ timeoutMs: 300 });
after(() => { runner.close(); untrustedSchemas.close(); });

test('uploaded schemas are checked in a worker; catastrophic patterns time out without blocking the app', async () => {
  const schema = { type: 'object', properties: { name: { type: 'string', pattern: '(a+)+$' } } };
  assert.deepEqual(await runner.run('validate', schema, { name: 'aaa' }), { valid: true, errors: [] });
  const invalid = await runner.run('validate', schema, { name: 7 });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].instancePath, '/name');
  assert.deepEqual(await runner.run('validate', { type: 'nonsense' }, {}), { invalidSchema: true });
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  const started = Date.now();
  await assert.rejects(runner.run('validate', schema, { name: `${'a'.repeat(40)}!` }), SchemaTimeoutError);
  clearInterval(ticker);
  assert.ok(Date.now() - started < 2000);
  assert.ok(ticks >= 10, `the event loop kept running (${ticks} ticks)`);
  // The next task gets a fresh worker.
  assert.equal((await runner.run('validate', schema, { name: 'a' })).valid, true);
});

test('custom action payloads and property defaults use the worker', async () => {
  assert.deepEqual(await payloadProblems({ type: 'object', required: ['goal'] }, {}, runner), ['payload must have required property \'goal\'']);
  assert.deepEqual(await payloadProblems({ type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } }, { x: `${'a'.repeat(40)}!` }, runner),
    ['Checking the payload took too long: the custom action\'s payload schema is too complex.']);
  assert.deepEqual(await propertyDefaults({ type: 'object', properties: { a: { type: 'string', default: 'x' }, b: { type: 'number' } } }, runner), { a: 'x' });
  assert.deepEqual(await propertyDefaults(null, runner), {});
});

test('production refuses missing, short and published session secrets', () => {
  assert.equal(sessionSecret(undefined, false), 'local-development-secret');
  for (const value of [undefined, '', 'change-me-in-production', 'replace-with-a-long-random-value', 'short']) {
    assert.throws(() => sessionSecret(value, true), /SESSION_SECRET/);
  }
  const strong = 'k'.repeat(40);
  assert.equal(sessionSecret(strong, true), strong);
});

const run = (middleware, request) => {
  let result = 'next';
  middleware({ method: 'POST', host: 'grafonaut.example.com', path: '/', get: (name) => request.headers?.[name], ...request },
    { sendStatus: (code) => { result = code; }, status: (code) => ({ json: () => { result = code; } }) }, () => {});
  return result;
};

test('changing API requests must come from the app\'s own origin', () => {
  assert.equal(run(sameOriginWrites, { method: 'GET', headers: { 'sec-fetch-site': 'same-site' } }), 'next');
  assert.equal(run(sameOriginWrites, { headers: { 'sec-fetch-site': 'same-origin' } }), 'next');
  assert.equal(run(sameOriginWrites, { headers: { origin: 'https://grafonaut.example.com' } }), 'next');
  assert.equal(run(sameOriginWrites, { headers: {} }), 'next');
  assert.equal(run(sameOriginWrites, { headers: { 'sec-fetch-site': 'same-site', origin: 'https://render.example.com' } }), 403);
  assert.equal(run(sameOriginWrites, { headers: { origin: 'https://render.example.com' } }), 403);
  assert.equal(run(sameOriginWrites, { headers: { origin: 'null' } }), 403);
  assert.equal(run(sameOriginWrites, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } }), 403);
});

test('graphics files are only served on the graphics host, which serves nothing else', () => {
  const hosts = createHosts({ appHosts: ['grafonaut.example.com'], rendererHost: { host: 'render.example.com' }, graphicsHost: { host: 'graphics.example.com' } });
  assert.equal(hosts.isolated, true);
  assert.deepEqual(hosts.hosts, ['grafonaut.example.com', 'render.example.com', 'graphics.example.com']);
  const answer = (host, path) => run(hosts.routing, { method: 'GET', host, path });
  for (const path of ['/render/frame', '/render/assets/v/index.html', '/render/media/x.png']) {
    assert.equal(answer('graphics.example.com', path), 'next', path);
    assert.equal(answer('grafonaut.example.com', path), 404, path);
    assert.equal(answer('render.example.com', path), 404, path);
  }
  assert.equal(answer('graphics.example.com', '/health'), 'next');
  for (const path of ['/', '/api/auth/me', '/render/token/', '/AAAA/ograf/v1/']) assert.equal(answer('graphics.example.com', path), 404, path);
  assert.equal(answer('render.example.com', '/render/token/'), 'next');
  assert.equal(answer('grafonaut.example.com', '/render/token/'), 404);
  assert.equal(answer('grafonaut.example.com', '/api/auth/me'), 'next');
  const upgrade = (host, url) => hosts.allowsUpgrade({ headers: { host }, url });
  assert.equal(upgrade('render.example.com', '/render/token/ws'), true);
  assert.equal(upgrade('graphics.example.com', '/render/token/ws'), false);
  assert.equal(upgrade('grafonaut.example.com', '/render/token/ws'), false);
  assert.equal(hosts.graphicsOrigin({ protocol: 'https', host: 'render.example.com' }), 'https://graphics.example.com');
});

test('without a graphics host, graphics run opaque and are served on the renderer (or any) host', () => {
  const shared = createHosts({});
  assert.equal(shared.isolated, false);
  assert.equal(run(shared.routing, { method: 'GET', host: 'grafonaut.example.com', path: '/render/token/' }), 'next');
  const renderer = createHosts({ rendererHost: { origin: 'https://render.example.com:8443' } });
  assert.equal(renderer.graphicsOrigin({ protocol: 'https', host: 'grafonaut.example.com' }), 'https://render.example.com:8443');
  assert.equal(run(renderer.routing, { method: 'GET', host: 'grafonaut.example.com', path: '/render/token/' }), 404);
  assert.equal(run(renderer.routing, { method: 'GET', host: 'render.example.com:8443', path: '/render/token/' }), 'next');
  assert.equal(run(renderer.routing, { method: 'GET', host: 'grafonaut.example.com', path: '/render/assets/v/a.png' }), 'next');
});

test('the graphics host must be a host of its own', () => {
  assert.throws(() => createHosts({ rendererHost: { host: 'render.example.com' }, graphicsHost: { origin: 'https://render.example.com' } }), /GRAPHICS_HOST/);
  assert.throws(() => createHosts({ appHosts: ['grafonaut.example.com'], graphicsHost: { host: 'grafonaut.example.com' } }), /GRAPHICS_HOST/);
  assert.throws(() => parseHostSetting('graphics.example.com/x', 'GRAPHICS_HOST'), /Invalid GRAPHICS_HOST/);
});

test('renderer pages load graphic frames and modules from the graphics origin and only talk to it', () => {
  const request = { protocol: 'https', host: 'render.example.com' };
  const config = (page) => JSON.parse(/<script type="application\/json" id="renderer-config">(.*?)<\/script>/s.exec(page.html)[1]);
  const isolated = rendererDocument(request, 'tok', { isolated: true, graphicsOrigin: 'https://graphics.example.com' });
  assert.deepEqual(config(isolated), { socketPath: '/render/tok/ws', framePath: 'https://graphics.example.com/render/frame',
    assetOrigin: 'https://graphics.example.com', messageOrigin: 'https://graphics.example.com', sandbox: 'allow-scripts allow-same-origin' });
  assert.match(isolated.headers['Content-Security-Policy'], /frame-src https:\/\/graphics\.example\.com(;|$)/);
  assert.match(isolated.headers['Content-Security-Policy'], /connect-src wss:\/\/render\.example\.com/);
  const shared = rendererDocument(request, 'tok');
  assert.deepEqual(config(shared), { socketPath: '/render/tok/ws', framePath: 'https://render.example.com/render/frame',
    assetOrigin: 'https://render.example.com', messageOrigin: '*', sandbox: 'allow-scripts' });
});
