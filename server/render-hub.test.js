import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, beforeEach, test } from 'node:test';
import { createRenderHub, moduleUrl, RendererError } from './render-hub.js';

let entries;
let instances;
const store = {
  listRenderEntries: async () => entries,
  listRenderInstances: async () => [...instances.values()],
  deleteRenderInstances: async (_account, ids) => { for (const id of ids) instances.delete(id); }
};
const hub = createRenderHub(store, { commandTimeout: 300 });
const server = http.createServer();
const account = { id: 7 };
hub.attachServer(server, async (token, kind) => (kind === 'renderer' && token === 'good-token' ? account : null));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `ws://127.0.0.1:${server.address().port}`;
after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));

beforeEach(() => {
  entries = [{ entryId: '1', enabled: true, packageDisabled: false }, { entryId: '2', enabled: true, packageDisabled: false }];
  instances = new Map([['2', { entryId: '2', instanceId: 'gi-2', versionId: 'v2', mainFile: 'dir/main file.mjs', data: { a: 1 }, currentStep: 0, playing: true }]]);
});

// A scripted renderer: records messages and answers commands with `answer(message)`.
async function renderer(answer = () => ({ result: { statusCode: 200 } }), token = 'good-token') {
  const socket = new WebSocket(`${base}/render/${token}/ws`);
  const messages = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    messages.push(message);
    if (message.type === 'command') {
      const reply = answer(message);
      if (reply) socket.send(JSON.stringify({ type: 'reply', id: message.id, ...reply }));
    }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  return { socket, messages, next: (type) => waitFor(() => messages.find((message) => message.type === type)) };
}
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}
const closeAll = (...renderers) => Promise.all(renderers.map(({ socket }) => {
  if (socket.readyState === WebSocket.CLOSED) return null;
  socket.close();
  return once(socket, 'close');
}));

test('a connecting renderer receives the order and the on-air state', async () => {
  const client = await renderer();
  const state = await client.next('state');
  assert.deepEqual(state.order, ['1', '2']);
  assert.deepEqual(state.instances, [{ instanceId: 'gi-2', entryId: '2', module: '/render/assets/v2/dir/main%20file.mjs', data: { a: 1 }, currentStep: 0, playing: true }]);
  assert.equal(hub.connections(7).length, 1);
  await closeAll(client);
  await waitFor(() => hub.connections(7).length === 0);
});

test('unknown renderer tokens are closed with 4401', async () => {
  const socket = new WebSocket(`${base}/render/bad-token/ws`);
  const [event] = await once(socket, 'close');
  assert.equal(event.code, 4401);
  assert.equal(hub.connections(7).length, 0);
});

test('commands go to every renderer and resolve with the first reply', async () => {
  const slow = await renderer(() => null);
  const fast = await renderer((message) => ({ result: { statusCode: 200, currentStep: 3, extra: 'dropped' } }));
  const result = await hub.command(7, { action: 'playAction', instanceId: 'gi-2', params: {} });
  assert.deepEqual(result, { statusCode: 200, currentStep: 3 });
  assert.equal(slow.messages.filter((message) => message.type === 'command').length, 1);
  await closeAll(slow, fast);
});

test('graphic errors, timeouts and missing renderers are distinguished', async () => {
  await assert.rejects(hub.command(7, { action: 'playAction' }), (error) => error instanceof RendererError && error.kind === 'no-renderer');
  const failing = await renderer(() => ({ error: { message: 'boom', graphic: true } }));
  await assert.rejects(hub.command(7, { action: 'playAction' }), (error) => error.kind === 'graphic' && error.message === 'boom');
  await closeAll(failing);
  const silent = await renderer(() => null);
  await assert.rejects(hub.command(7, { action: 'playAction' }), (error) => error.kind === 'timeout');
  await closeAll(silent);
});

test('a renderer disconnecting mid-command fails the command instead of waiting', async () => {
  const leaving = await renderer((message) => { leaving.socket.close(); return null; });
  await assert.rejects(hub.command(7, { action: 'stopAction' }), (error) => error.kind === 'no-renderer');
});

test('entry changes drop stale instances and resend the state', async () => {
  const client = await renderer();
  await client.next('state');
  entries[1].enabled = false;
  await hub.syncEntries(7);
  assert.equal(instances.size, 0);
  await waitFor(() => client.messages.filter((message) => message.type === 'state').length === 2);
  assert.deepEqual(client.messages.at(-1).instances, []);
  await closeAll(client);
});

test('disconnect closes every renderer of the account with 4401', async () => {
  const first = await renderer();
  const second = await renderer();
  hub.disconnect(7);
  const [[firstEvent], [secondEvent]] = await Promise.all([once(first.socket, 'close'), once(second.socket, 'close')]);
  assert.deepEqual([firstEvent.code, secondEvent.code], [4401, 4401]);
});

test('module URLs encode the version and each path segment', () => {
  assert.equal(moduleUrl('v1', 'a b/c#d.mjs'), '/render/assets/v1/a%20b/c%23d.mjs');
});
