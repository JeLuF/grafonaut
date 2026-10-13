import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { after, beforeEach, test } from 'node:test';
import { apiMountPath, apiUrl, createOgrafApi } from './ograf-api.js';
import { RendererError } from './render-hub.js';

const token = 'A'.repeat(43);
let entries;
let instances;
let commands;
let connected;
let answer;
const store = {
  listRenderEntries: async () => entries,
  listRenderInstances: async () => [...instances.values()],
  saveRenderInstance: async (_account, entryId, state) => {
    const entry = entries.find((candidate) => candidate.entryId === entryId);
    instances.set(entryId, { entryId, instanceId: state.instanceId, data: state.data, currentStep: state.currentStep ?? null,
      playing: Boolean(state.playing), ended: Boolean(state.ended), versionId: entry.versionId, mainFile: entry.mainFile });
  },
  deleteRenderInstances: async (_account, ids) => { for (const id of ids) instances.delete(id); },
  findAccountGraphic: async (_account, versionId) => versionId === 'v1' ? { manifest: { id: 'l3rd', name: 'Lower third' }, createdAt: '2026-10-01T10:00:00Z' } : null
};
const hub = {
  connections: () => Array.from({ length: connected }),
  command: async (_account, message) => {
    commands.push({ message, stored: [...instances.keys()] });
    return answer(message);
  },
  broadcastState: async () => { commands.push({ message: { action: 'state' } }); }
};
const account = { id: 7, twitch_login: 'host', twitch_display_name: 'Host' };
const app = express();
app.use(apiMountPath, createOgrafApi({ hub, store, findAccountByToken: async (value, kind) => (kind === 'api' && value === token ? account : null) }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/${token}/ograf/v1`;
after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  entries = [
    { entryId: '1', label: 'Left', enabled: true, packageDisabled: false, versionId: 'v1', versionLabel: '1.0', display_name: 'Lower third', description: 'Name', mainFile: 'main.mjs' },
    { entryId: '2', label: null, enabled: false, packageDisabled: false, versionId: 'v1', versionLabel: '1.0', display_name: 'Lower third', description: 'Name', mainFile: 'main.mjs' },
    { entryId: '3', label: null, enabled: true, packageDisabled: false, versionId: 'v2', versionLabel: '2.0', display_name: 'Clock', description: '', mainFile: 'clock/main.mjs' },
    { entryId: '4', label: null, enabled: true, packageDisabled: false, versionId: 'v3', versionLabel: '1.0', display_name: 'Sting', description: '', mainFile: 'sting.mjs', stepCount: 0 }
  ];
  instances = new Map();
  commands = [];
  connected = 1;
  answer = (message) => ({ statusCode: 200, ...(message.action === 'playAction' ? { currentStep: 0 } : {}) });
});

const call = async (method, path, body, raw) => {
  const response = await fetch(`${base}${path}`, { method, headers: body !== undefined || raw ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
};
const load = (entryId = '1', graphicId = 'v1', data = { name: 'Host' }) =>
  call('POST', '/renderers/main/target/graphicInstance/load', { renderTarget: { entryId }, graphicId, params: { data } });

test('the entry point returns server information and rejects unknown tokens', async () => {
  const info = await call('GET', '/');
  assert.equal(info.status, 200);
  assert.equal(info.body.name, 'OGraf Platform');
  assert.equal(info.body.description, 'OGraf Server API for Host');
  assert.equal(info.headers.get('access-control-allow-origin'), '*');
  const unknown = await fetch(`${base.replace(token, 'B'.repeat(43))}/`);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { title: 'Unauthorized', status: 401, detail: 'Unknown or replaced API token.', instance: '/' });
});

test('graphics list the account’s My Graphics versions once each', async () => {
  const list = await call('GET', '/graphics');
  assert.deepEqual(list.body, { graphics: [{ id: 'v1', name: 'Lower third', description: 'Name' }, { id: 'v2', name: 'Clock' }, { id: 'v3', name: 'Sting' }] });
  const graphic = await call('GET', '/graphics/v1');
  assert.deepEqual(graphic.body, { graphic: { id: 'l3rd', name: 'Lower third' }, metadata: { createdAt: '2026-10-01T10:00:00.000Z' } });
  assert.equal((await call('GET', '/graphics/v9')).status, 404);
});

test('the renderer lists My Graphics entries as render targets with their instances', async () => {
  await load();
  const { body } = await call('GET', '/renderers/main');
  assert.equal(body.renderer.id, 'main');
  assert.deepEqual(body.renderer.status, { status: 'OK', message: '1 renderer connection', connections: 1 });
  assert.deepEqual(body.renderer.renderTargets.map((target) => [target.renderTarget.entryId, target.name, target.graphicInstances.length]),
    [['1', 'Left', 1], ['2', 'Lower third', 0], ['3', 'Clock', 0], ['4', 'Sting', 0]]);
  assert.match(body.renderer.renderTargets[1].description, /\(disabled\)/);
  const target = await call('GET', `/renderers/main/target?renderTarget=${encodeURIComponent('{"entryId":"1"}')}`);
  assert.equal(target.body.graphicInstances[0].graphic.id, 'v1');
  assert.equal(target.body.graphicInstances[0].playing, false);
  assert.equal((await call('GET', '/renderers/other')).status, 404);
  assert.equal((await call('GET', '/renderers/main/target?renderTarget=%7B%22entryId%22%3A%229%22%7D')).status, 404);
  connected = 0;
  assert.equal((await call('GET', '/renderers/main')).body.renderer.status.status, 'WARNING');
});

test('load stores the instance before the renderers load it and returns its id', async () => {
  const response = await load();
  assert.equal(response.status, 200);
  assert.match(response.body.graphicInstanceId, /^gi-/);
  assert.equal(response.body.statusCode, 200);
  const [{ message, stored }] = commands;
  assert.deepEqual(stored, ['1']);
  assert.deepEqual(message, { action: 'load', instanceId: response.body.graphicInstanceId, entryId: '1', module: '/render/assets/v1/main.mjs', data: { name: 'Host' } });
});

test('load is refused for wrong graphics, disabled entries, bad params and missing renderers', async () => {
  assert.equal((await load('9')).status, 404);
  assert.equal((await load('1', 'v2')).status, 404);
  assert.equal((await load('2')).status, 409);
  assert.equal((await call('POST', '/renderers/main/target/graphicInstance/load', { renderTarget: { entryId: '1' }, graphicId: 'v1', params: 'x' })).status, 400);
  connected = 0;
  const offline = await load();
  assert.equal(offline.status, 503);
  assert.equal(offline.body.detail, 'No renderer is connected.');
  assert.equal(instances.size, 0);
  assert.equal(commands.length, 0);
});

test('a failed load is rolled back and graphic errors map to 550', async () => {
  answer = () => { throw new RendererError('graphic', 'load() exploded'); };
  const failed = await load();
  assert.equal(failed.status, 550);
  assert.equal(failed.body.detail, 'load() exploded');
  assert.equal(instances.size, 0);
  assert.equal(commands.at(-1).message.action, 'state');
  answer = () => { throw new RendererError('timeout', 'The renderer did not respond in time.'); };
  assert.equal((await load()).status, 500);
});

test('play, update and stop drive the instance and keep its state', async () => {
  const { body: { graphicInstanceId } } = await load();
  const target = { renderTarget: { entryId: '1' }, graphicInstanceId };
  const played = await call('POST', '/renderers/main/target/graphicInstance/playAction', { ...target, params: { delta: 1, junk: true } });
  assert.deepEqual(played.body, { graphicInstanceId, statusCode: 200, currentStep: 0 });
  assert.deepEqual(commands.at(-1).message.params, { delta: 1 });
  assert.equal(instances.get('1').playing, true);
  const updated = await call('POST', '/renderers/main/target/graphicInstance/updateAction', { ...target, params: { data: { title: 'Guest' } } });
  assert.equal(updated.status, 200);
  assert.deepEqual(instances.get('1').data, { name: 'Host', title: 'Guest' });
  await call('POST', '/renderers/main/target/graphicInstance/customActions/highlight', { ...target, params: { payload: { on: true } } });
  assert.deepEqual(commands.at(-1).message, { action: 'customAction', instanceId: graphicInstanceId, entryId: '1', params: { id: 'highlight', payload: { on: true } } });
  await call('POST', '/renderers/main/target/graphicInstance/stopAction', { ...target, params: {} });
  assert.deepEqual([instances.get('1').playing, instances.get('1').currentStep], [false, null]);
});

test('actions need the current instance id and required params', async () => {
  const { body: { graphicInstanceId } } = await load();
  const action = (name, body) => call('POST', `/renderers/main/target/graphicInstance/${name}`, body);
  assert.equal((await action('playAction', { renderTarget: { entryId: '1' }, graphicInstanceId: 'gi-old', params: {} })).status, 404);
  assert.equal((await action('playAction', { renderTarget: { entryId: '3' }, graphicInstanceId, params: {} })).status, 404);
  assert.equal((await action('updateAction', { renderTarget: { entryId: '1' }, graphicInstanceId, params: {} })).status, 400);
  assert.equal((await action('customActions/x', { renderTarget: { entryId: '1' }, graphicInstanceId, params: {} })).status, 400);
});

test('clear removes matching instances and resyncs the renderers', async () => {
  await load('1');
  await load('3', 'v2');
  const cleared = await call('PUT', '/renderers/main/target/graphicInstance/clear', { filters: [{ graphicId: 'v2' }] });
  assert.deepEqual(cleared.body.graphicInstances.map((item) => item.renderTarget.entryId), ['3']);
  assert.deepEqual([...instances.keys()], ['1']);
  assert.equal(commands.at(-1).message.action, 'state');
  const all = await call('PUT', '/renderers/main/target/graphicInstance/clear', { filters: [] });
  assert.equal(all.body.graphicInstances.length, 1);
  assert.equal(instances.size, 0);
  assert.equal((await call('PUT', '/renderers/main/target/graphicInstance/clear', {})).status, 400);
});

test('malformed bodies, preflights and unimplemented endpoints answer with problem details', async () => {
  const invalid = await call('POST', '/renderers/main/target/graphicInstance/load', undefined, '{not json');
  assert.equal(invalid.status, 400);
  const preflight = await call('OPTIONS', '/renderers/main/target/graphicInstance/playAction');
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
  assert.equal((await call('POST', '/renderers/main/customActions/x', { payload: {} })).status, 404);
  const pending = await call('DELETE', '/graphics/v1');
  assert.equal(pending.status, 501);
  assert.equal(pending.body.instance, '/graphics/v1');
});

test('the API URL uses the main page host and the token path scope', () => {
  assert.equal(apiUrl({ protocol: 'https', host: 'app.example.com' }, token), `https://app.example.com/${token}/ograf/v1/`);
});

const play = (entryId, graphicInstanceId) => call('POST', '/renderers/main/target/graphicInstance/playAction',
  { renderTarget: { entryId }, graphicInstanceId, params: {} });

test('a graphic with stepCount 0 is played once: afterwards it is ended, not on air', async () => {
  const { body: { graphicInstanceId } } = await load('4', 'v3');
  answer = () => ({ statusCode: 200 });
  assert.equal((await play('4', graphicInstanceId)).status, 200);
  assert.deepEqual([instances.get('4').playing, instances.get('4').ended], [false, true]);
  const target = await call('GET', `/renderers/main/target?renderTarget=${encodeURIComponent('{"entryId":"4"}')}`);
  assert.deepEqual([target.body.graphicInstances[0].playing, target.body.graphicInstances[0].ended], [false, true]);
  // Playing it again works and it ends again.
  assert.equal((await play('4', graphicInstanceId)).status, 200);
  assert.equal(instances.get('4').playing, false);
});

test('playing past the last step ends a graphic that reports its steps', async () => {
  const { body: { graphicInstanceId } } = await load();
  answer = () => ({ statusCode: 200, currentStep: 0 });
  await play('1', graphicInstanceId);
  assert.deepEqual([instances.get('1').playing, instances.get('1').ended, instances.get('1').currentStep], [true, false, 0]);
  answer = () => ({ statusCode: 200 });
  await play('1', graphicInstanceId);
  assert.deepEqual([instances.get('1').playing, instances.get('1').ended, instances.get('1').currentStep], [false, true, null]);
  // From the end, a new play starts it again.
  answer = () => ({ statusCode: 200, currentStep: 0 });
  await play('1', graphicInstanceId);
  assert.deepEqual([instances.get('1').playing, instances.get('1').ended], [true, false]);
});

test('graphics that never report a step stay on air until stopped', async () => {
  const { body: { graphicInstanceId } } = await load();
  answer = () => ({ statusCode: 200 });
  await play('1', graphicInstanceId);
  await play('1', graphicInstanceId);
  assert.deepEqual([instances.get('1').playing, instances.get('1').ended], [true, false]);
  await call('POST', '/renderers/main/target/graphicInstance/stopAction', { renderTarget: { entryId: '1' }, graphicInstanceId, params: {} });
  assert.deepEqual([instances.get('1').playing, instances.get('1').ended], [false, true]);
});
